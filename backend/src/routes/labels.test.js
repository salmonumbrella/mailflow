import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../services/lastSeen.js', () => ({ touchLastSeen: vi.fn() }));
import express from 'express';
import routes from './labels.js';
import { query, withTransaction } from '../services/db.js';
import { csrfGuard } from '../middleware/csrfGuard.js';
import { screenLockGate } from '../middleware/screenLock.js';
import { matchApiTokenRoute } from '../services/apiTokenAllowlist.js';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const GENERATION = '44444444-4444-4444-8444-444444444444';
const ID = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const row = (extra = {}) => ({ id: ID, account_id: ACCOUNT, parent_id: null, name: 'Work', normalized_name: 'work', full_path: 'Work', color: null, text_color: null,
  sidebar_visibility: 'show', message_visibility: true, revision: '1', ...extra });
let server, base;
const broadcast = vi.fn();
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.set('imapManager', { broadcast });
  app.use((req, _res, next) => { req.session = req.get('x-anonymous') ? {} : { userId: 'owner', locked: req.get('x-locked') === 'yes' }; next(); });
  app.use('/api', csrfGuard, screenLockGate); app.use('/api/labels', routes);
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/labels`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => {
  vi.clearAllMocks();
  query.mockImplementation(async sql => ({ rows: sql.includes('SELECT id FROM users') ? [{ id: 'owner' }] : [] }));
  withTransaction.mockRejectedValue(new Error('Unexpected write transaction'));
});
const call = async (method, path = '', body, headers = {}) => {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() };
};
const body = extra => ({ accountId: ACCOUNT, name: 'Work', mutationId: randomUUID(), ...extra });
function transaction({ rows = [], revision = '0', replay, owned = true, failInsert = false } = {}) {
  const client = { query: vi.fn(async (sql) => {
    if (sql.includes('FROM email_accounts')) return { rows: owned ? [{ id: ACCOUNT, storage_generation: GENERATION }] : [] };
    if (sql.startsWith('SELECT tree_revision')) return { rows: [{ tree_revision: revision }] };
    if (sql.includes('SELECT request_hash')) return { rows: replay ? [replay] : [] };
    if (sql.startsWith('SELECT * FROM mail_labels')) return { rows };
    if (failInsert && sql.startsWith('INSERT INTO mail_labels')) throw Object.assign(new Error('Duplicate'), { code: '23505' });
    return { rows: [] };
  }) };
  withTransaction.mockImplementation(fn => fn(client));
  return client;
}

describe('native label route security and validation', () => {
  it.each([
    ['GET', `?accountId=${ACCOUNT}`, undefined],
    ['POST', '', body()],
    ['PATCH', `/${ID}`, body({ expectedRevision: '1' })],
    ['POST', `/${ID}/delete-preview`, { accountId: ACCOUNT }],
    ['DELETE', `/${ID}`, { accountId: ACCOUNT, mutationId: randomUUID(), expectedTreeRevision: '1', confirmSubtree: true }],
  ])('requires a session and honors screen lock on %s %s', async (method, path, input) => {
    expect((await call(method, path, input, { 'x-anonymous': 'yes' })).status).toBe(401);
    expect((await call(method, path, input, { 'x-locked': 'yes' })).status).toBe(423);
    expect(withTransaction).not.toHaveBeenCalled();
    expect(matchApiTokenRoute(method, `/api/labels${path}`)).toBeNull();
  });
  it.each(['POST', 'PATCH', 'DELETE'])('rejects missing CSRF header for %s', async method => {
    expect((await call(method, method === 'POST' ? '' : `/${ID}`, body(), { 'x-requested-with': '' })).status).toBe(403);
    expect(withTransaction).not.toHaveBeenCalled();
  });
  it.each([{ name: '' }, { name: 'bad/name' }, { color: 'url(javascript:alert(1))' }, { textColor: '#fff' }, { visibility: 'never' }, { messageVisible: 'false' }, { parentId: 'bad' }, { mutationId: 'bad' }, { accountId: 'bad' }, { applyToMessages: [ID] }])('rejects invalid input before writes: %j', async extra => {
    expect((await call('POST', '', body(extra))).status).toBe(400);
    expect(withTransaction).not.toHaveBeenCalled();
  });
  it('returns indistinguishable not-found for inaccessible account and preview label', async () => {
    expect((await call('GET', `?accountId=${ACCOUNT}`))).toMatchObject({ status: 404, body: { code: 'not_found' } });
    const client = transaction({ owned: false });
    expect((await call('POST', '', body())).status).toBe(404);
    expect(client.query).toHaveBeenCalledTimes(1);
  });
  it('keeps router behind the common API chain and leaves provider/cache modules outside its dependency boundary', () => {
    const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    expect(index.indexOf('mountApiAuth(app,')).toBeGreaterThanOrEqual(0);
    expect(index.indexOf('mountApiAuth(app,')).toBeLessThan(index.indexOf("app.use('/api/labels', labelRoutes)"));
    const service = readFileSync(new URL('../services/nativeLabelDefinitions.js', import.meta.url), 'utf8');
    const imports = service.split('\n').filter(line => line.startsWith('import '));
    expect(imports).toEqual(["import { createHash, randomUUID } from 'crypto';", "import { query, withTransaction } from './db.js';"]);
    expect(service).not.toMatch(/(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:messages|folders)\b/i);
  });
});

describe('native label route contracts', () => {
  it('lists and previews one consistent read snapshot without inserting state or fabricating counts', async () => {
    query.mockImplementation(async sql => ({ rows: sql.includes('SELECT id FROM users') ? [{ id: 'owner' }] : [{ tree_revision: '9007199254740993', labels: [row(), row({ id: OTHER, parent_id: ID, name: 'Child', normalized_name: 'child', full_path: 'Work/Child' })] }] }));
    const state = await call('GET', `?accountId=${ACCOUNT}`);
    expect(state.body).toMatchObject({ counts: null, coverage: 'synchronized-cache', assignmentSupported: true, treeRevision: '9007199254740993' });
    expect(state.body.labels[0]).not.toHaveProperty('normalizedName');
    const previewClient = transaction({ rows: [row(), row({ id: OTHER, parent_id: ID, name: 'Child', normalized_name: 'child', full_path: 'Work/Child' })], revision: '9007199254740993' });
    const preview = await call('POST', `/${ID}/delete-preview`, { accountId: ACCOUNT });
    expect(preview.body).toMatchObject({ deletedLabelIds: [ID, OTHER], removesMessages: false, counts: null });
    expect(previewClient.query.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(previewClient.query.mock.calls.some(([sql]) => /^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
    const reads = query.mock.calls.filter(([sql]) => sql.includes('jsonb_agg'));
    expect(reads).toHaveLength(1);
    for (const [, params] of reads) expect(params).toEqual([ACCOUNT, 'owner']);
  });
  it('commits label, revision and durable replay response through the same transaction, then pushes to its owner', async () => {
    const client = transaction();
    const result = await call('POST', '', body({ color: '#AABBCC', messageVisible: false }));
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ label: { color: '#aabbcc', messageVisible: false, revision: '1' }, treeRevision: '1', assignmentSupported: true });
    const statements = client.query.mock.calls.map(([sql]) => sql);
    expect(statements.findIndex(sql => sql.includes('FOR UPDATE'))).toBeLessThan(statements.findIndex(sql => sql.startsWith('INSERT INTO mail_labels')));
    const journal = client.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO mail_label_mutations'));
    expect(JSON.parse(journal[1][3])).toEqual(result.body);
    expect(broadcast).toHaveBeenCalledWith({ type: 'labels_changed', accountId: ACCOUNT, storageGeneration: GENERATION, treeRevision: '1' }, 'owner');
  });
  it('returns success after commit even if the push transport is unavailable', async () => {
    transaction(); broadcast.mockImplementationOnce(() => { throw new Error('closed'); });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await call('POST', '', body())).status).toBe(201);
    expect(warning).toHaveBeenCalled(); warning.mockRestore();
  });
  it('does not write label/tree revision or publish for a no-op edit', async () => {
    const client = transaction({ rows: [row()], revision: '7' });
    const result = await call('PATCH', `/${ID}`, { accountId: ACCOUNT, expectedRevision: '1', mutationId: randomUUID(), color: null });
    expect(result.body.treeRevision).toBe('7');
    expect(client.query.mock.calls.map(([sql]) => sql).filter(sql => sql.startsWith('UPDATE mail_labels') || sql.startsWith('UPDATE mail_label_state'))).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
  });
  it('updates descendant paths without overwriting descendant preferences', async () => {
    const client = transaction({ rows: [row(), row({ id: OTHER, parent_id: ID, name: 'Child', normalized_name: 'child', full_path: 'Work/Child', color: '#123456' })], revision: '2' });
    const result = await call('PATCH', `/${ID}`, { accountId: ACCOUNT, expectedRevision: '1', mutationId: randomUUID(), name: 'Renamed' });
    expect(result.status).toBe(200);
    const descendant = client.query.mock.calls.find(([sql, args]) => sql.startsWith('UPDATE mail_labels') && args[1] === OTHER);
    expect(descendant[0]).not.toMatch(/color=/);
    expect(descendant[1]).toEqual([ACCOUNT, OTHER, 'Renamed/Child']);
  });
  it('rejects stale tree revision and stale label revision without deletion or push', async () => {
    const client = transaction({ rows: [row()], revision: '9' });
    expect((await call('DELETE', `/${ID}`, { accountId: ACCOUNT, mutationId: randomUUID(), expectedTreeRevision: '8', confirmSubtree: true }))).toMatchObject({ status: 409, body: { code: 'stale_tree_revision' } });
    expect((await call('PATCH', `/${ID}`, { accountId: ACCOUNT, mutationId: randomUUID(), expectedRevision: '0', color: null }))).toMatchObject({ status: 409, body: { code: 'stale_label_revision' } });
    expect(client.query.mock.calls.map(([sql]) => sql).some(sql => sql.startsWith('DELETE'))).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
  });
  it('replays an exact request before checking now-deleted labels or stale revisions', async () => {
    const payload = body(); const firstClient = transaction();
    const result = await call('POST', '', payload);
    const requestHash = firstClient.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO mail_label_mutations'))[1][2];
    broadcast.mockClear();
    const replayClient = transaction({ replay: { request_hash: requestHash, response: result.body, expired: false } });
    expect(await call('POST', '', payload)).toEqual(result);
    expect(replayClient.query.mock.calls.some(([sql]) => sql.includes('SELECT * FROM mail_labels'))).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
    expect((await call('POST', '', { ...payload, name: 'Changed' }))).toMatchObject({ status: 409, body: { code: 'mutation_conflict' } });
    transaction({ replay: { request_hash: requestHash, response: null, expired: true } });
    expect((await call('POST', '', payload))).toMatchObject({ status: 409, body: { code: 'mutation_expired' } });
  });
  it('maps database uniqueness conflicts to 409 without pushing a rolled-back result', async () => {
    transaction({ failInsert: true });
    expect((await call('POST', '', body()))).toMatchObject({ status: 409, body: { code: 'duplicate_name' } });
    expect(broadcast).not.toHaveBeenCalled();
  });
});
