import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: async callback => callback({query}) }));
vi.mock('../services/nativeLabelMemberships.js', () => ({ captureRuleMembershipBatchInTransaction: async (_client,_user,rows) => rows.map(source => ({availability:'unknown',source,labelIds:null})) }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: req.headers['x-test-user'] || 'owner' }; next(); } }));
vi.mock('../services/inboxRules.js', () => ({ applyInboxRules: vi.fn(), isDangerousRegex: () => false, RULE_CATEGORIES: new Set() }));
import express from 'express';
import rulesRoutes from './rules.js';
import { query } from '../services/db.js';
import { applyInboxRules } from '../services/inboxRules.js';

const ID = 'e5e5e5e5-5555-4555-8555-e5e5e5e5e5e5';
const ACCOUNT = 'd5e5e5e5-5555-4555-8555-e5e5e5e5e5e5';
const imap = { broadcast: vi.fn() };
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

describe('apply only one saved filter to existing Inbox messages', () => {
  let server, base, rule, rows, accountRows;
  beforeAll(async () => {
    const app = express(); app.use(express.json()); app.set('imapManager', imap); app.use('/rules', rulesRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/rules`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => {
    query.mockReset(); applyInboxRules.mockReset(); imap.broadcast.mockReset();
    rule = { id: ID, user_id: 'owner', account_id: ACCOUNT, enabled: true, conditions: [{ field: 'from', operator: 'contains', value: 'alice' }], actions: [{ type: 'star' }] };
    accountRows = [{ id: ACCOUNT, include_in_unified_inbox: true }];
    rows = [{ id: 'message-1', uid: 12, folder: 'INBOX' }];
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM inbox_rules')) return { rows: rule ? [structuredClone(rule)] : [] };
      if (sql.includes('FROM email_accounts WHERE user_id')) return { rows: accountRows };
      if (sql.includes('FROM email_accounts WHERE id')) return { rows: [{ id: ACCOUNT, user_id: 'owner' }] };
      if (sql.includes('FROM messages')) { const result = rows; rows = []; return { rows: result }; }
      return { rows: [] };
    });
    applyInboxRules.mockResolvedValue({ remaining: [{ id: 'message-1' }], matchedCount: 1, failedCount: 0 });
  });
  const run = (id = ID, body = { accountIds: [ACCOUNT], scopeAccountId: null }) => fetch(`${base}/${id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  it('snapshots only the owned rule and keeps non-moving matches in totals', async () => {
    expect((await run()).status).toBe(202);
    await tick();
    expect(query.mock.calls[0][1]).toEqual([ID, 'owner']);
    expect(query.mock.calls[1][1]).toEqual(['owner']);
    expect(applyInboxRules.mock.calls[0][3]).toEqual({ rule, shouldContinue: expect.any(Function) });
    const sql = query.mock.calls.find(([sql]) => sql.includes('FROM messages'))[0];
    expect(sql).toContain("lower(folder) = 'inbox' AND is_deleted = false");
    expect(imap.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'rules_run_complete', ok: true, ruleId: ID, processed: 1, matched: 1, failed: 0, status: 'completed' }), 'owner');
  });
  it('never executes missing, foreign or disabled rules', async () => {
    rule = null;
    expect((await run()).status).toBe(404);
    expect(applyInboxRules).not.toHaveBeenCalled();
  });
  it('rejects malformed IDs before any database access', async () => {
    expect((await run('invalid')).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
  it('does not replay forwarding or unsupported historical conditions', async () => {
    rule.actions = [{ type: 'forward', value: 'thirdparty@example.test' }];
    expect((await run()).status).toBe(400);
    rule.actions = [{ type: 'star' }]; rule.conditions = [{ field: 'header', value: 'value' }];
    expect((await run()).status).toBe(400);
    expect(applyInboxRules).not.toHaveBeenCalled();
  });
  it('reports partial failure instead of claiming successful application', async () => {
    applyInboxRules.mockResolvedValue({ remaining: [], matchedCount: 1, failedCount: 1 });
    expect((await run()).status).toBe(202);
    await tick();
    expect(imap.broadcast.mock.calls[0][0]).toMatchObject({ ok: false, failed: 1, matched: 1 });
  });
  it('reports pending identity recovery without failure or replaying the same run', async () => {
    applyInboxRules.mockResolvedValue({ remaining: [{ id: 'message-1' }], matchedCount: 1, failedCount: 0,
      identityPending: true, pendingIds: ['message-1'] });
    const started = await (await run()).json();
    await tick();
    const status = await (await fetch(`${base}/${ID}/run?runId=${started.runId}`)).json();
    expect(status).toMatchObject({ status: 'pending_recovery', processed: 1, matched: 1, failed: 0,
      pendingCount: 1, identityPending: true });
    expect(imap.broadcast.mock.calls[0][0]).toMatchObject({ ok: false, status: 'pending_recovery', pendingCount: 1 });
    const repeated = await run(ID, { accountIds: [ACCOUNT], runId: started.runId });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ status: 'pending_recovery', pendingCount: 1 });
    expect(applyInboxRules).toHaveBeenCalledOnce();
  });
  it('excludes simultaneous targeted or all-rule sweeps', async () => {
    let release;
    applyInboxRules.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    expect((await run()).status).toBe(202);
    expect((await run()).status).toBe(409);
    release({ remaining: [], matchedCount: 1, failedCount: 0 });
    await tick();
    expect((await run()).status).toBe(202);
    await tick();
  });
  it('rejects omitted, foreign and unified opted-out accounts without running actions', async () => {
    expect((await run(ID, {})).status).toBe(400);
    accountRows = [{ id: ACCOUNT, include_in_unified_inbox: false }];
    expect((await run()).status).toBe(409);
    expect((await run(ID, { accountIds: ['f5e5e5e5-5555-4555-8555-e5e5e5e5e5e5'], scopeAccountId: null })).status).toBe(409);
    expect(applyInboxRules).not.toHaveBeenCalled();
    // Explicit account view may intentionally include an opted-out account.
    expect((await run(ID, { accountIds: [ACCOUNT], scopeAccountId: ACCOUNT })).status).toBe(202);
    await tick();
  });
  it('rejects stale unified scope before creating a future filter', async () => {
    accountRows = [{ id: ACCOUNT, include_in_unified_inbox: false }];
    const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      name: 'Test', accountId: ACCOUNT, conditions: rule.conditions, actions: rule.actions,
      searchScope: { accountIds: [ACCOUNT], scopeAccountId: null },
    }) });
    expect(response.status).toBe(409);
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO inbox_rules'))).toBe(false);
  });
  it('never sweeps enabled accounts omitted from the displayed selection', async () => {
    const other = 'f5e5e5e5-5555-4555-8555-e5e5e5e5e5e5';
    rule.account_id = null;
    accountRows.push({ id: other, include_in_unified_inbox: false });
    expect((await run()).status).toBe(202);
    await tick();
    const accountCalls = query.mock.calls.filter(([sql]) => sql.includes('FROM email_accounts WHERE id'));
    expect([...new Set(accountCalls.map(([, params]) => params[0]))]).toEqual([ACCOUNT]);
  });
  it('rejects malformed condition types instead of silently reporting no matches', async () => {
    rule.conditions[0].value = { untrusted: true };
    expect((await run()).status).toBe(400);
    expect(applyInboxRules).not.toHaveBeenCalled();
  });
  it('provides owned status and stops after cancellation without replaying a run id', async () => {
    let release, canContinue;
    applyInboxRules.mockImplementation((_messages, _account, _imap, options) => {
      canContinue = options.shouldContinue;
      return new Promise(resolve => { release = resolve; });
    });
    const started = await (await run()).json();
    const statusUrl = `${base}/${ID}/run?runId=${started.runId}`;
    expect((await fetch(statusUrl)).status).toBe(200);
    expect((await fetch(statusUrl, { headers: { 'x-test-user': 'foreign' } })).status).toBe(404);
    const cancel = (runId, user = 'owner') => fetch(`${base}/${ID}/run/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': user }, body: JSON.stringify({ runId }) });
    expect((await cancel(started.runId, 'foreign')).status).toBe(404);
    expect((await cancel('wrong-run')).status).toBe(404);
    expect(await canContinue()).toBe(true);
    expect((await cancel(started.runId)).status).toBe(200);
    expect(await canContinue()).toBe(false);
    release({ remaining: [], matchedCount: 1, failedCount: 0, processedCount: 1, cancelled: true });
    await tick();
    expect((await (await fetch(statusUrl)).json()).status).toBe('cancelled');
    const repeated = await run(ID, { accountIds: [ACCOUNT], runId: started.runId });
    expect(repeated.status).toBe(200);
    expect(applyInboxRules).toHaveBeenCalledTimes(1);
    rows = [];
    const newer = await (await run()).json();
    await tick();
    expect(newer.runId).not.toBe(started.runId);
    expect((await cancel(started.runId)).status).toBe(404);
  });
  it('cancellation during a revision read cannot authorize one more action', async () => {
    let finish, shouldContinue;
    applyInboxRules.mockImplementation((_messages, _account, _imap, options) => {
      shouldContinue = options.shouldContinue;
      return new Promise(resolve => { finish = resolve; });
    });
    const started = await (await run()).json();
    let releaseRead;
    query.mockImplementationOnce(() => new Promise(resolve => { releaseRead = resolve; }));
    const continuation = shouldContinue();
    const cancelled = await fetch(`${base}/${ID}/run/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: started.runId }) });
    expect(cancelled.status).toBe(200);
    releaseRead({ rows: [{ enabled: true }] });
    expect(await continuation).toBe(false);
    finish({ remaining: [], matchedCount: 0, failedCount: 0, processedCount: 0, cancelled: true });
    await tick();
  });
  it.each(['disabled', 'deleted', 'edited'])('stops when the source rule is %s before the next action', async change => {
    rule.updated_at = new Date('2026-11-10T00:00:00.100Z');
    applyInboxRules.mockImplementation(async (_messages, _account, _imap, options) => {
      if (change === 'disabled') rule.enabled = false;
      if (change === 'deleted') rule = null;
      if (change === 'edited') rule.updated_at = new Date('2026-11-10T00:00:00.200Z');
      expect(await options.shouldContinue()).toBe(false);
      return { remaining: [], matchedCount: 0, failedCount: 0, processedCount: 0, cancelled: true };
    });
    expect((await run()).status).toBe(202);
    await tick();
    expect(imap.broadcast.mock.calls[0][0]).toMatchObject({ status: 'cancelled', ok: false });
  });

});
