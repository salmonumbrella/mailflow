import 'express-async-errors';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'reader' }; next(); } }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { hasActiveAsync: vi.fn(), collectHook: vi.fn(), runHook: vi.fn() } }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('../services/encryption.js', () => ({ decrypt: () => 'test-password', encrypt: () => 'enc' }));
vi.mock('../services/hostValidation.js', () => ({ resolveForConnection: vi.fn(async () => ({ host: '127.0.0.1', servername: null })), createPinnedLookup: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: true, allowInsecureTls: true })) }));
vi.mock('./oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
import express from 'express';
import mailRoutes from './mail.js';
import { imapManager } from '../index.js';
import { ImapManager } from '../services/imapManager.js';
import { ImapFlow } from 'imapflow';
import { query } from '../services/db.js';
import { pluginRegistry } from '../plugins/registry.js';
const A = 'a0000000-0000-4000-8000-000000000001', B = 'b0000000-0000-4000-8000-000000000002', C = 'c0000000-0000-4000-8000-000000000003';
const MID = '<copy@example.test>';
let account, rows, wire, hold, releaseHold, selectionHold, releaseSelection, gtd, labels, failFolder, fanoutHold, releaseFanout, failBoundary, stampHold, releaseStamp, proofHold, releaseProof, failNextStore, serial = 0;
let intentVersion = 0n;
class Mailbox extends EventEmitter {
  constructor() { super(); this.usable = true; }
  async connect() {}
  close() { this.usable = false; }
  async logout() { this.close(); }
  async noop() { return true; }
  async getMailboxLock(folder) { this.mailbox = { path: folder, exists: 3, uidValidity: 1n }; return { release() {} }; }
  async messageFlagsAdd(uid, flags, options) { return this.store(uid, flags, options, true); }
  async messageFlagsRemove(uid, flags, options) { return this.store(uid, flags, options, false); }
  async store(uid, flags, options, value) {
    const folder = this.mailbox.path;
    expect(options).toEqual({ uid: true }); expect(flags).toEqual(['\\Flagged']);
    if (folder === hold) await new Promise(resolve => { releaseHold = resolve; });
    if (failNextStore > 0) { failNextStore--; throw new Error('first STORE failed'); }
    if (folder === failFolder) throw new Error('fake STORE refusal');
    wire.push([folder, String(uid), value]); return true;
  }
  async search(q, options) {
    expect(options).toEqual({uid:true});
    if (proofHold) { proofHold = false; await new Promise(resolve => { releaseProof = resolve; }); }
    const terms = q.or || [q];
    return rows.filter(r => r.folder === this.mailbox.path && terms.some(term =>
      r.message_id.includes(term.header?.['Message-ID'] || '__absent__'))).map(r => r.uid);
  }
  async *fetch(range, projection, options) {
    expect(projection.envelope).toBe(true); expect(options).toEqual({uid:true});
    for (const uid of String(range).split(',').map(Number)) {
      const row = rows.find(r => r.folder === this.mailbox.path && Number(r.uid) === uid);
      if (row) yield {uid,envelope:{messageId:row.message_id}};
    }
  }

}
// SQL projections reflect production RETURNING; fake rows cannot hide missing columns.
async function database(sql, params = []) {
  if (failBoundary === 'fanout' && sql.includes('UPDATE messages') && sql.includes('message_id = $3')) throw new Error('fanout unavailable');
  if (sql.includes('nextval(')) return { rows: [{ version: String(++intentVersion) }], rowCount: 1 };
  if (sql.startsWith('SELECT id, message_id, flag_address_valid')) return { rows: rows.filter(r => r.account_id === params[0] && r.folder === params[1] && Number(r.uid) === Number(params[2]) && !r.is_deleted).map(r => ({ ...r })) };
  if (sql.includes('THEN NULL ELSE') && sql.includes('UPDATE messages')) {
    const flag = sql.includes('star_changed_at') ? 'star' : 'read';
    const versionCol = `${flag}_intent_version`, markerCol = `${flag}_changed_at`;
    const target = rows.find(r => r.id === params[0]);
    if (!target || BigInt(target[versionCol]) > BigInt(params[1])) return { rows: [], rowCount: 0 };
    if (target[markerCol] === params[2]) target[markerCol] = null;
    target[versionCol] = params[1]; return { rows: [], rowCount: 1 };
  }
  if (sql.includes('UPDATE messages') && /(?:star|read)_intent_version/.test(sql)) {
    const flag = sql.includes('star_intent_version') ? 'star' : 'read';
    const field = flag === 'star' ? 'is_starred' : 'is_read';
    const markerCol = `${flag}_changed_at`, versionCol = `${flag}_intent_version`;
    const reassert = sql.includes(`SET ${field} = $1`);
    const singleFan = sql.includes('message_id = $3');
    if (singleFan && params[0] === true && fanoutHold) {
      fanoutHold = false; await new Promise(resolve => { releaseFanout = resolve; });
    }
    const marker = params[singleFan ? 3 : reassert ? 2 : 1];
    const version = params[singleFan ? 4 : reassert ? 3 : 2];
    if (stampHold && reassert && !singleFan && params[0] === true && params[1] === stampHold) {
      stampHold = null; await new Promise(resolve => { releaseStamp = resolve; });
    }
    const targets = rows.filter(r => singleFan
      ? r.account_id === params[1] && r.message_id === params[2] && (!sql.includes(`${field} <> $1`) || r[field] !== params[0])
      : r.id === params[reassert ? 1 : 0]);
    const applied = targets.filter(r => BigInt(r[versionCol]) < BigInt(version)
      || (r[versionCol] === version && r[markerCol] === marker));
    for (const r of applied) {
      r[versionCol] = version; r[markerCol] = marker;
      if (reassert) r[field] = params[0];
    }
    const returning = sql.split('RETURNING')[1];
    return { rows: returning ? applied.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => new RegExp(`\\b${k}\\b`).test(returning)))) : [], rowCount: applied.length };
  }
  if (sql.startsWith('SELECT id, uid, is_starred FROM messages')) return { rows: rows.filter(r => r.folder === params[1] && r.message_id === params[2] && !r.is_deleted).map(r => ({ ...r })) };
  if (failBoundary === 'account' && sql.includes('FROM email_accounts')) throw new Error('account lookup unavailable');
  if (failBoundary === 'selection' && sql.includes('from_email') && sql.trimStart().startsWith('SELECT')) throw new Error('selection unavailable');
  if (sql.includes('FROM email_accounts')) return { rows: [account] };
  if (sql.includes('FROM messages m') && sql.includes('JOIN email_accounts')) {
    const ids = Array.isArray(params[1]) ? params[1] : [params[0]];
    return { rows: rows.filter(r => ids.includes(r.id)).map(r => ({ ...r, user_id: 'reader', sibling_count: rows.length })) };
  }
  if (sql.trimStart().startsWith('SELECT') && sql.includes('FROM messages')) {
    if (sql.includes('from_email') && selectionHold) await new Promise(resolve => { releaseSelection = resolve; });
    return { rows: rows.filter(r => r.account_id === params[0] && r.message_id === params[1] && !r.is_deleted).map(r => ({ ...r })) };
  }
  if (sql.includes('UPDATE messages') && sql.includes('is_starred = $1')) {
    if (sql.includes('message_id = $3') && params[0] === true && fanoutHold) {
      fanoutHold = false;
      await new Promise(resolve => { releaseFanout = resolve; });
    }
    const targets = sql.includes('FROM (')
      ? rows.filter(r => !params[1].includes(r.id) && r.is_starred !== params[0] && rows.some(a => params[1].includes(a.id) && a.message_id === r.message_id && a.account_id === r.account_id))
      : sql.includes('message_id = $3')
      ? rows.filter(r => r.account_id === params[1] && r.message_id === params[2] && r.is_starred !== params[0])
      : rows.filter(r => (Array.isArray(params[1]) ? params[1] : [params[1]]).includes(r.id));
    for (const r of targets) r.is_starred = params[0];
    const returning = sql.split('RETURNING')[1];
    return { rows: returning ? targets.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => new RegExp(`\\b${k}\\b`).test(returning)))) : [] };
  }
  return { rows: [] };
}
const row = (id, folder, uid, extra = {}) => ({ id, account_id: account.id, message_id: MID, from_email: 'sender@example.test', date: '2026-10-20T12:00:00.000Z', subject: 'Same copied message', body_hash: 'same-body', to_addresses: ['reader@example.test'], cc_addresses: [], folder, uid, is_starred: false, is_deleted: false, flag_uid_validity: '1', flag_address_valid: true, star_intent_version: '0', star_changed_at: null, read_intent_version: '0', read_changed_at: null, ...extra });
const settle = async () => { for (let n = 0; n < 30; n++) await new Promise(resolve => setImmediate(resolve)); };
let server, url;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/mail', mailRoutes);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  url = `http://127.0.0.1:${server.address().port}/mail/messages`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  vi.clearAllMocks();
  account = { id: `copies-${++serial}`, user_id: 'reader', imap_host: 'imap.example.test', imap_port: 993, imap_tls: true, auth_user: 'reader', auth_pass: 'enc' };
  wire = []; proofHold = false; releaseProof = null; failNextStore = 0; stampHold = null; releaseStamp = null; failBoundary = null; fanoutHold = false; releaseFanout = null; selectionHold = false; releaseSelection = null; hold = null; failFolder = null; releaseHold = null; gtd = true; labels = ['Watch', 'Todo'];
  Object.setPrototypeOf(imapManager, ImapManager.prototype); Object.assign(imapManager, new ImapManager({ clients: new Set() }));
  clearInterval(imapManager._folderStatusTimer);
  const idle = new Mailbox(); idle.mailbox = { path: 'INBOX', exists: 3, uidValidity: 1n }; imapManager.connections.set(account.id, idle);
  ImapFlow.mockImplementation(function () { return new Mailbox(); });
  pluginRegistry.hasActiveAsync.mockImplementation(async () => { if (failBoundary === 'config') throw new Error('config unavailable'); return gtd; });
  pluginRegistry.collectHook.mockImplementation(async () => [labels]); pluginRegistry.runHook.mockResolvedValue([]);
  query.mockImplementation(async (sql, params) => database(sql, params)); rows = [row(A, 'INBOX', 11), row(B, 'Watch', 42)];
});
afterEach(async () => { hold = null; selectionHold = false; releaseHold?.(); releaseSelection?.(); releaseFanout?.(); releaseStamp?.(); releaseProof?.(); await settle(); await imapManager.disconnectAccount(account.id); vi.restoreAllMocks(); });
const starred = (id, value) => fetch(`${url}/${id}/star`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ starred: value }) });
const bulk = (ids, value) => fetch(`${url}/bulk-star`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, starred: value }) });
describe('starred-copy production routes and IMAP', () => {
  it('keeps a later confirmed unstar ahead of an older bulk action whose target is in the second batch', async () => {
    gtd = false; const broadcasts = vi.spyOn(imapManager, 'broadcast');
    const D = 'd0000000-0000-4000-8000-000000000004';
    rows = [row(A, 'INBOX', 11), row(B, 'INBOX', 12), row(C, 'INBOX', 13), row(D, 'INBOX', 14)];
    hold = 'INBOX'; const older = bulk([A, B, C, D], true);
    for (let n = 0; n < 200 && !releaseHold; n++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(releaseHold).toBeTypeOf('function');
    const later = starred(D, false);
    for (let n = 0; n < 200 && rows[3].is_starred !== false; n++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(rows[3].is_starred).toBe(false);
    hold = null; releaseHold();
    expect((await later).status).toBe(200); expect((await older).status).toBe(200); await settle();
    expect(wire.filter(([, uid]) => uid === '14').at(-1)).toEqual(['INBOX', '14', false]);
    expect(rows[3].is_starred).toBe(false);
    expect(broadcasts.mock.calls.flatMap(([event]) => event.changes || []).filter(r => r.id === D).at(-1)?.is_starred).toBe(false);
  });
  it('does not reassert old sibling DB state or clicked STORE after a newer unstar confirms during fanout', async () => {
    const broadcasts = vi.spyOn(imapManager, 'broadcast');
    fanoutHold = true; const older = starred(A, true);
    for (let n = 0; n < 200 && !releaseFanout; n++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(releaseFanout).toBeTypeOf('function');
    expect((await starred(A, false)).status).toBe(200); await settle();
    releaseFanout(); expect((await older).status).toBe(200); await settle();
    expect(rows.map(r => r.is_starred)).toEqual([false, false]);
    expect(wire.filter(([, uid]) => uid === '11').at(-1)).toEqual(['INBOX', '11', false]);
    expect(wire.some(([folder,, value]) => folder === 'Watch' && value === true)).toBe(false);
    expect(broadcasts.mock.calls.flatMap(([event]) => event.changes || []).filter(r => r.id === A).at(-1)?.is_starred).toBe(false);
  });

  it('fences an older delayed selected SQL when a later bulk unstar appears to be a no-op', async () => {
    gtd = false; stampHold = A; const older = bulk([A],true);
    await vi.waitFor(() => expect(releaseStamp).toBeTypeOf('function'));
    try { expect((await bulk([A],false)).status).toBe(200); } finally { releaseStamp(); }
    expect((await older).status).toBe(200); await settle();
    expect(rows[0].is_starred).toBe(false); expect(rows[0].star_changed_at).toBeNull();
    expect(wire.every(([, ,value]) => value === false)).toBe(true);
  });

  it('keeps same-value bulk ownership while an earlier in-flight STORE fails', async () => {
    gtd = false; hold = 'INBOX'; failNextStore = 1;
    const older = starred(A,true);
    await vi.waitFor(() => expect(releaseHold).toBeTypeOf('function'));
    const version = rows[0].star_intent_version;
    const newer = bulk([A],true);
    await vi.waitFor(() => expect(BigInt(rows[0].star_intent_version)).toBeGreaterThan(BigInt(version)));
    hold = null; releaseHold();
    expect((await newer).status).toBe(200); expect((await older).status).toBe(200); await settle();
    expect(wire.filter(([folder]) => folder === 'INBOX').at(-1)).toEqual(['INBOX','11',true]);
    expect(rows[0].star_changed_at).toBeNull();
  });
  for (const mode of ['single','bulk']) for (const boundary of ['account','fanout','config']) {
    it(`clears only its owned markers after ${mode} ${boundary} failure`, async () => {
      failBoundary = boundary;
      const result = await (mode === 'single' ? starred(A,true) : bulk([A],true));
      expect(result.status).toBe(500); await settle();
      expect(rows.every(r => r.star_changed_at === null)).toBe(true);
      expect(imapManager._pendingFlagPush.has(account.id)).toBe(false);
      expect(wire).toEqual([]);
    });
  }
  it('clears detached sibling markers when eligibility lookup fails', async () => {
    failBoundary = 'selection'; expect((await starred(A,true)).status).toBe(200); await settle();
    expect(rows.every(r => r.star_changed_at === null)).toBe(true);
    expect(imapManager._pendingFlagPush.has(account.id)).toBe(false);
    expect(wire).toEqual([['INBOX','11',true]]);
  });
  for (const failed of ['INBOX','Watch']) it(`retains only the failed ${failed} owned retry`, async () => {
    failFolder = failed; expect((await starred(A,true)).status).toBe(200); await settle();
    const failedRow = rows.find(r => r.folder === failed), confirmedRow = rows.find(r => r.folder !== failed);
    await vi.waitFor(() => expect(imapManager._pendingFlagPush.get(account.id)?.size).toBe(1));
    const pending = imapManager._pendingFlagPush.get(account.id);
    expect(pending.size).toBe(1); expect(pending.get(`${failedRow.id}:\\Flagged`).value).toBe(true);
    expect(failedRow.star_changed_at).not.toBeNull(); expect(confirmedRow.star_changed_at).toBeNull();
  });

  for (const fromLabel of [false, true]) for (const value of [false, true]) {
    it(`pushes starred=${value} from ${fromLabel ? 'label' : 'ordinary'} copy to both copies`, async () => {
      rows = [row(A, 'Sent', 11, { is_starred: !value }), row(B, 'Watch', 42, { is_starred: !value })];
      expect((await starred(fromLabel ? B : A, value)).status).toBe(200); await settle();
      expect(wire).toEqual(expect.arrayContaining([['Sent', '11', value], ['Watch', '42', value]])); expect(wire).toHaveLength(2);
    });
  }
  it('pushes the unselected bulk sibling too', async () => {
    expect((await bulk([A], true)).status).toBe(200); await settle();
    expect(wire).toEqual([['INBOX', '11', true], ['Watch', '42', true]]);
  });
  it('skips an older detached star after a newer confirmed unstar reaches its delayed selection', async () => {
    selectionHold = true; expect((await starred(A, true)).status).toBe(200); await settle();
    const releaseOld = releaseSelection; expect(releaseOld).toBeTypeOf('function'); selectionHold = false;
    expect((await starred(A, false)).status).toBe(200); await settle(); releaseOld(); await settle();
    expect(wire.filter(([folder]) => folder === 'Watch')).toEqual([['Watch', '42', false]]);
  });
  it('pushes bulk siblings once when both copies are selected', async () => {
    expect((await bulk([A, B], true)).status).toBe(200); await settle();
    expect(wire).toEqual([['INBOX', '11', true], ['Watch', '42', true]]);
  });
  it('does not wait for an added sibling STORE before responding', async () => {
    hold = 'Watch';
    const response = await Promise.race([starred(A, true), new Promise(resolve => setTimeout(() => resolve('blocked'), 250))]);
    expect(response).not.toBe('blocked'); expect(response.status).toBe(200);
    await settle(); expect(releaseHold).toBeTypeOf('function');
    hold = null; releaseHold(); await settle();
    expect(wire).toEqual([['INBOX', '11', true], ['Watch', '42', true]]);
  });
  for (const id of [null, '', '<>', '  <>  ']) {
    it(`does not propagate degenerate Message-ID ${JSON.stringify(id)}`, async () => {
      for (const r of rows) r.message_id = id;
      expect((await starred(A, true)).status).toBe(200); await settle(); expect(wire).toEqual([['INBOX', '11', true]]);
    });
  }
  it('does not propagate an ID reused by two ordinary messages', async () => {
    rows.push(row(C, 'INBOX', 12)); expect((await starred(A, true)).status).toBe(200); await settle(); expect(wire).toEqual([['INBOX', '11', true]]);
  });
  it('includes already-starred duplicates when deciding eligibility', async () => {
    rows.push(row(C, 'INBOX', 12, { is_starred: true }));
    expect((await starred(A, true)).status).toBe(200); await settle(); expect(wire).toEqual([['INBOX', '11', true]]);
  });
  for (const field of ['from_email', 'date', 'subject']) it(`rejects conflicting ${field} evidence`, async () => {
    rows[0][field] = 'first'; rows[1][field] = 'second';
    expect((await starred(A, true)).status).toBe(200); await settle(); expect(wire).toEqual([['INBOX', '11', true]]);
  });
  it('does not propagate between ordinary messages with no label copies', async () => {
    rows[1].folder = 'Archive'; expect((await starred(A, true)).status).toBe(200); await settle(); expect(wire).toEqual([['INBOX', '11', true]]);
  });
  it('honors configured label folders and skips soft-deleted copies', async () => {
    labels = ['Projects/Waiting']; rows[1].folder = labels[0]; rows.push(row(C, 'Todo', 99, { is_deleted: true }));
    expect((await starred(A, true)).status).toBe(200); await settle(); expect(wire).toEqual([['INBOX', '11', true], ['Projects/Waiting', '42', true]]);
  });
  it('preserves non-GTD writes', async () => {
    gtd = false; expect((await starred(A, true)).status).toBe(200); await settle(); expect(wire).toEqual([['INBOX', '11', true]]);
  });
  it('preserves Gmail single-copy writes', async () => {
    account.imap_host = 'imap.gmail.com'; expect((await starred(A, true)).status).toBe(200); await settle(); expect(wire).toEqual([['INBOX', '11', true]]);
  });
});



describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('star request ordering on actual PostgreSQL', () => {
  let db;
  beforeAll(async () => {
    const { Client } = (await import('pg')).default;
    db = new Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await db.connect();
    await db.query(`CREATE TEMP SEQUENCE message_flag_intent_version_seq;
      CREATE TEMP TABLE email_accounts(id text PRIMARY KEY, user_id text, imap_host text,
        imap_port integer, imap_tls boolean, auth_user text, auth_pass text, enabled boolean DEFAULT true);
      CREATE TEMP TABLE messages(id uuid PRIMARY KEY, account_id text, uid bigint, folder text,
        message_id text, is_starred boolean, is_read boolean DEFAULT false, is_deleted boolean,
        from_email text, date timestamptz, subject text, to_addresses jsonb, cc_addresses jsonb,
        flag_address_valid boolean, flag_uid_validity bigint, star_intent_version bigint DEFAULT 0,
        read_intent_version bigint DEFAULT 0, star_changed_at timestamptz, read_changed_at timestamptz)`);
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => {
    await db.query('TRUNCATE messages, email_accounts');
    await db.query('INSERT INTO email_accounts(id,user_id,imap_host,imap_port,imap_tls,auth_user,auth_pass) VALUES($1,$2,$3,$4,$5,$6,$7)', Object.values(account));
    for (const r of rows) await insertRow(r);
    query.mockImplementation((sql, params) => db.query(sql, params));
  });
  async function insertRow(r) {
    await db.query(`INSERT INTO messages(id,account_id,uid,folder,message_id,is_starred,is_deleted,
      from_email,date,subject,to_addresses,cc_addresses,flag_address_valid,flag_uid_validity)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,1)`,
    [r.id,r.account_id,r.uid,r.folder,r.message_id,r.is_starred,r.is_deleted,r.from_email,r.date,r.subject,
      JSON.stringify(r.to_addresses),JSON.stringify(r.cc_addresses)]);
  }
  for (const boundary of ['clicked', 'fanout', 'bulk-noop']) it(`preserves a newer confirmed unstar across old ${boundary} SQL`, async () => {
    let paused = false, release;
    query.mockImplementation(async (sql, args) => {
      if (!paused && args?.[0] === true && sql.includes('UPDATE messages SET is_starred = $1')
        && sql.includes('message_id = $3') === (boundary === 'fanout')) {
        paused = true; await new Promise(resolve => { release = resolve; });
      }
      return db.query(sql, args);
    });
    const older = starred(A, true);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    try {
      expect((await (boundary === 'bulk-noop' ? bulk([A],false) : starred(A,false))).status).toBe(200); await settle();
    } finally { release(); }
    expect((await older).status).toBe(200); await settle();
    await vi.waitFor(async () => expect((await db.query('SELECT is_starred,star_changed_at FROM messages ORDER BY id')).rows)
      .toEqual([{ is_starred:false,star_changed_at:null },{ is_starred:false,star_changed_at:null }]));
    expect(wire.some(([, ,value]) => value === true)).toBe(false);
  });
  it('fences all genuine copies when a later bulk no-op targets a different copy', async () => {
    await insertRow(row(C,'Todo',99));
    let release, held = false;
    query.mockImplementation(async (sql,args) => {
      if (!held && args?.[0] === true && sql.includes('UPDATE messages SET is_starred = $1') && sql.includes('message_id = $3')) {
        held = true; await new Promise(resolve => { release = resolve; });
      }
      return db.query(sql,args);
    });
    const older = starred(A,true);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    try { expect((await bulk([B],false)).status).toBe(200); } finally { release(); }
    expect((await older).status).toBe(200);
    await vi.waitFor(async () => {
      const result = (await db.query('SELECT is_starred,star_changed_at,star_intent_version FROM messages ORDER BY id')).rows;
      expect(result.map(r => r.is_starred)).toEqual([false,false,false]);
      expect(result.every(r => r.star_changed_at === null)).toBe(true);
      expect(new Set(result.map(r => r.star_intent_version)).size).toBe(1);
    });
    expect(wire.filter(([,uid]) => uid === '11').at(-1)?.[2]).toBe(false);
    expect(wire.some(([, ,value]) => value === true)).toBe(false);
  });
  it('keeps a current copy intent queued while a newer refused address proof holds it', async () => {
    selectionHold = true;
    query.mockImplementation(async (sql,args) => {
      if (selectionHold && sql.trimStart().startsWith('SELECT') && sql.includes('from_email')) {
        selectionHold = false; await new Promise(resolve => { releaseSelection = resolve; });
      }
      return db.query(sql,args);
    });
    expect((await starred(A,true)).status).toBe(200);
    await vi.waitFor(() => expect(releaseSelection).toBeTypeOf('function'));
    proofHold = true;
    const invalid = imapManager.setFlag(account,42,'Watch','\\Flagged',false,{expectMessageId:'<missing@test>'}).catch(error => error);
    await vi.waitFor(() => expect(releaseProof).toBeTypeOf('function'));
    try {
      releaseSelection();
      await vi.waitFor(() => expect(imapManager._pendingFlagPush.get(account.id)?.get(`${B}:\\Flagged`)?.value).toBe(true));
      const held = (await db.query('SELECT is_starred,star_changed_at FROM messages WHERE id=$1',[B])).rows[0];
      expect(held.is_starred).toBe(true); expect(held.star_changed_at).not.toBeNull();
    } finally { releaseProof(); }
    expect((await invalid).unsafeFlagAddress).toBe(true);
    await imapManager._reconcileFlagPushes();
    expect(wire.filter(([folder]) => folder === 'Watch')).toEqual([['Watch','42',true]]);
    expect((await db.query('SELECT star_changed_at FROM messages WHERE id=$1',[B])).rows[0].star_changed_at).toBeNull();
  });
  it('confirms or retains a same-value pending retry when a repeated bulk request appears unchanged', async () => {
    failFolder = 'INBOX'; expect((await starred(A,true)).status).toBe(200);
    await vi.waitFor(() => expect(imapManager._pendingFlagPush.get(account.id)?.get(`${A}:\\Flagged`)?.value).toBe(true));
    failFolder = null; expect((await bulk([A],true)).status).toBe(200);
    const pending = imapManager._pendingFlagPush.get(account.id)?.get(`${A}:\\Flagged`);
    expect(wire.some(([folder,,value]) => folder === 'INBOX' && value === true) || pending?.value === true).toBe(true);
    await imapManager._reconcileFlagPushes();
    expect(wire.filter(([folder]) => folder === 'INBOX').at(-1)).toEqual(['INBOX','11',true]);
    expect((await db.query('SELECT is_starred,star_changed_at FROM messages WHERE id=$1',[A])).rows[0])
      .toEqual({is_starred:true,star_changed_at:null});
  });
  it('protects a later confirmed fourth-row unstar before the old bulk second batch', async () => {
    gtd = false;
    const D = 'd0000000-0000-4000-8000-000000000004';
    await db.query('TRUNCATE messages');
    for (const r of [row(A,'INBOX',11),row(B,'INBOX',12),row(C,'INBOX',13),row(D,'INBOX',14)]) await insertRow(r);
    hold = 'INBOX'; const older = bulk([A,B,C,D],true);
    await vi.waitFor(() => expect(releaseHold).toBeTypeOf('function'));
    const later = starred(D,false);
    await vi.waitFor(async () => expect((await db.query('SELECT is_starred FROM messages WHERE id=$1',[D])).rows[0].is_starred).toBe(false));
    hold = null; releaseHold();
    expect((await later).status).toBe(200); expect((await older).status).toBe(200); await settle();
    expect((await db.query('SELECT is_starred,star_changed_at FROM messages WHERE id=$1',[D])).rows[0])
      .toEqual({is_starred:false,star_changed_at:null});
    expect(wire.filter(([,uid]) => uid === '14')).toEqual([['INBOX','14',false]]);
  });
});
