import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); } }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('../services/aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('../services/encryption.js', () => ({ decrypt: vi.fn(() => 'pw') }));
vi.mock('../services/hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('../services/pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../index.js', async () => {
  const { ImapManager } = await import('../services/imapManager.js');
  return { imapManager: new ImapManager(null) };
});

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { evictPool } from '../services/imapManager.js';
import { ImapFlow } from 'imapflow';
import { resolveForConnection } from '../services/hostValidation.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';

const { searchCompiler } = createRequire(import.meta.url)('imapflow/lib/search-compiler.js');
const realFlow = createRequire(import.meta.url)('imapflow').ImapFlow.prototype;
const expungeCommand = createRequire(import.meta.url)('imapflow/lib/commands/expunge.js');
const compileCommand = createRequire(import.meta.url)('imapflow/lib/handler/imap-compiler.js');
const atoms = attrs => attrs.flatMap(a => Array.isArray(a) ? atoms(a) : [a.value]);
let searchCommands, fetchCommands;
const A = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const FIRST = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
const SECOND = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';
let account, rows, folders, nextUid, client, uidplus;
const row = (id, uid, message_id, folder = 'INBOX') => ({ id, uid, message_id, folder, account_id: A, user_id: 'user-1', is_read: false });
const selectUids = range => String(range).split(',').map(Number);
function fakeQuery(raw, p = []) {
  const sql = raw.replace(/\s+/g, ' ').trim();
  const result = rows => ({ rows, rowCount: rows.length });
  if (sql.includes('FROM messages m JOIN email_accounts a')) {
    return result([...rows.values()].filter(m => Array.isArray(p[1]) ? p[1].includes(m.id) : m.id === p[0]).map(m => ({ ...m })));
  }
  if (sql.startsWith('SELECT * FROM email_accounts')) return result([account]);
  if (sql.startsWith('SELECT path FROM folders')) return result([{ path: sql.includes('Drafts') || sql.includes('drafts') ? 'Drafts' : 'Trash' }]);
  if (sql.startsWith('DELETE FROM messages WHERE id = ANY')) {
    p[0].forEach(id => rows.delete(id));
    return result([]);
  }
  if (sql === 'DELETE FROM messages WHERE id = $1') { rows.delete(p[0]); return result([]); }
  const update = sql.match(/^UPDATE messages SET (.+) WHERE id = \$(\d+)$/);
  if (update) {
    const m = rows.get(p[Number(update[2]) - 1]);
    rows.delete(m.id);
    for (const assignment of update[1].split(',')) {
      const [column, value] = assignment.split('=').map(s => s.trim());
      m[column] = value === 'gen_random_uuid()' ? randomUUID() : p[Number(value.slice(1)) - 1];
    }
    rows.set(m.id, m);
  }
  return result([]);
}
function fakeClient() {
  const deleted = new Set();
  const c = Object.assign(new EventEmitter(), {
    usable: true, connect: async () => {}, close: () => {}, noop: async () => true,
    capabilities: new Map([['MOVE', true], ...(uidplus ? [['UIDPLUS', true]] : [])]),
    getMailboxLock: async folder => {
      expect(c.locked).not.toBe(true);
      c.locked = true; c.mailbox = { path: folder, uidValidity: 7n };
      return { release() { c.locked = false; } };
    },
    fetch: async function* (range, query, opts) {
      fetchCommands.push(String(range));
      expect(c.locked).toBe(true);
      expect(query).toMatchObject({ envelope: true });
      expect(opts).toEqual({ uid: true });
      for (const uid of selectUids(range)) if (folders[c.mailbox.path].has(uid)) {
        yield { uid, envelope: { messageId: folders[c.mailbox.path].get(uid) } };
      }
    },
    search: async (q, opts) => {
      expect(c.locked).toBe(true);
      expect(opts).toEqual({ uid: true });
      if (q.uid) return selectUids(q.uid).filter(uid => folders[c.mailbox.path].has(uid));
      if (q.deleted) return [];
      if (q.header || q.or) {
        searchCommands.push(atoms(searchCompiler(c, q)));
        const terms = (q.or || [q]).flatMap(condition => Object.values(condition.header));
        return [...folders[c.mailbox.path]].filter(([, mid]) => terms.some(term => mid?.includes(term))).map(([uid]) => uid);
      }
      throw new Error(`Unexpected search ${JSON.stringify(q)}`);
    },
    messageMove: async (range, dest, opts) => {
      expect(opts).toEqual({ uid: true });
      const uid = Number(range), to = nextUid++;
      folders[dest].set(to, folders[c.mailbox.path].get(uid));
      folders[c.mailbox.path].delete(uid);
      return uidplus ? { uidMap: new Map([[uid, to]]) } : {};
    },
    messageFlagsAdd: async (range, flags, opts) => {
      expect(flags).toEqual(['\\Deleted']); expect(opts).toEqual({ uid: true });
      selectUids(range).forEach(uid => deleted.add(uid)); return true;
    },
    exec: async (command, attributes) => {
      expect(command).toBe(uidplus ? 'UID EXPUNGE' : 'EXPUNGE');
      const targets = uidplus ? selectUids(attributes[0].value) : [...deleted];
      targets.forEach(uid => folders[c.mailbox.path].delete(uid));
      return { response: { attributes: [] }, next() {} };
    },
    messageDelete: async (range, opts) => {
      expect(c.locked).toBe(true);
      expect(opts).toEqual({ uid: true });
      selectUids(range).forEach(uid => folders[c.mailbox.path].delete(uid));
      return true;
    },
  });
  return c;
}

let srv, base;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/api/mail', mailRoutes);
  await new Promise(r => { srv = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${srv.address().port}/api/mail`;
});
afterAll(async () => { await new Promise(r => srv.close(r)); });
beforeEach(() => {
  vi.clearAllMocks(); searchCommands = []; fetchCommands = [];
  uidplus = false;
  account = { id: A, user_id: 'user-1', imap_host: 'imap.example.test', auth_user: 'me', auth_pass: 'enc' };
  rows = new Map([row(FIRST, 11, '<first@test>'), row(SECOND, 10, '<second@test>')].map(m => [m.id, m]));
  folders = { INBOX: new Map([[11, '<first@test>'], [10, '<second@test>']]), Trash: new Map(), Drafts: new Map() };
  nextUid = 10;
  client = fakeClient();
  ImapFlow.mockImplementation(function () { return client; });
  query.mockImplementation(async (...args) => fakeQuery(...args));
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
  imapManager.broadcast = vi.fn(); imapManager.scheduleCountRefresh = vi.fn();
});
afterEach(() => { evictPool(A); });
const countWrites = () => query.mock.calls.filter(([sql]) => sql.includes('UPDATE folders f'));
const del = id => fetch(`${base}/messages/${id}`, { method: 'DELETE' });
const bulk = ids => fetch(`${base}/messages/bulk-delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });

function epochWire(stage) {
  let deleted = new Set([99]), epoch = 7n;
  const writes = [], commands = [], next = vi.fn();
  const lock = client.getMailboxLock;
  client.getMailboxLock = async folder => { const result = await lock(folder); client.mailbox.uidValidity = epoch; return result; };
  const change = at => {
    if (stage !== at) return;
    epoch = client.mailbox.uidValidity = 8n;
    if (at === 'folder') { folders.Other = new Map([[11, '<unrelated@test>']]); client.mailbox.path = 'Other'; }
    else folders.Trash = new Map([[11, '<unrelated@test>'], [99, '<new-other@test>']]);
    deleted = new Set([99]);
  };
  const search = client.search, fetch = client.fetch;
  client.search = async (...args) => {
    const [q] = args;
    const result = q.deleted ? [...deleted] : await search(...args);
    change(q.header || q.or ? 'search' : q.deleted ? 'flagged' : 'ours'); return result;
  };
  client.fetch = async function* (...args) { yield* fetch(...args); change('fetch'); change('folder'); };
  client.messageFlagsRemove = async (range, flags, opts) => {
    expect([flags, opts]).toEqual([['\\Deleted'], { uid: true }]);
    writes.push([client.mailbox.uidValidity, 'remove', range]);
    selectUids(range).forEach(uid => deleted.delete(uid)); change('unflag'); return true;
  };
  client.messageFlagsAdd = async (range, flags, opts) => {
    expect([flags, opts]).toEqual([['\\Deleted'], { uid: true }]);
    writes.push([client.mailbox.uidValidity, 'add', range]);
    selectUids(range).forEach(uid => deleted.add(uid)); if (range === '11') change('store'); return true;
  };
  Object.assign(client, { state: 1, states: { SELECTED: 1, LOGOUT: 2 }, socket: { destroyed: false },
    enabled: new Set(), tagCounter: 0, requestTagMap: new Map(), requestQueue: [], log: { warn() {} }, autoidle() {},
    commands: new Map([['EXPUNGE', expungeCommand]]),
  });
  for (const method of ['exec', 'run', 'runInternal', 'resolveRange', 'messageDelete']) client[method] = realFlow[method].bind(client);
  client.trySend = async () => {
    const request = client.requestQueue.shift();
    const { resolve, reject } = client.requestTagMap.get(request.tag);
    try {
      const wire = (await compileCommand(request)).toString(); commands.push(wire);
      expect(wire).toBe(`${request.tag} ${uidplus ? 'UID EXPUNGE 11' : 'EXPUNGE'}`);
      if (!uidplus) expect(deleted.has(99)).toBe(false);
      if (stage === 'server-error') return reject(new Error('EXPUNGE refused'));
      for (const uid of [...deleted]) if (!uidplus || uid === 11) folders[client.mailbox.path].delete(uid);
      change('expunge');
      resolve({ response: { attributes: [{ section: [{ value: 'HIGHESTMODSEQ' }, { value: '9007199254740993' }] }] }, next });
    } catch (err) { reject(err); }
  };
  return { writes, commands, next };
}

// The wrong target is created by real route MOVE calls, not by injecting a stale route UID.
async function swappedTrash() {
  expect((await del(FIRST)).status).toBe(200);
  expect((await del(SECOND)).status).toBe(200);
  expect([...folders.Trash]).toEqual([[10, '<first@test>'], [11, '<second@test>']]);
  return [...rows.values()].find(m => m.message_id === '<first@test>');
}
describe('permanent delete identity through real routes and IMAP methods', () => {
  for (const withUidplus of [false, true]) for (const mode of ['single', 'bulk']) {
    for (const stage of ['search', 'fetch', 'folder', 'store', 'expunge', ...(!withUidplus ? ['ours', 'flagged', 'unflag'] : [])]) {
      it(`${mode} binds deletion proof to its selected epoch at ${stage}, UIDPLUS=${withUidplus}`, async () => {
        uidplus = withUidplus; client = fakeClient();
        rows = new Map([[FIRST, row(FIRST, 11, '<wanted@test>', 'Trash')]]);
        folders.Trash = new Map([[11, '<wanted@test>'], [99, '<other@test>']]);
        const before = { ...rows.get(FIRST) }, wire = epochWire(stage);
        const response = await (mode === 'single' ? del(FIRST) : bulk([FIRST]));
        if (mode === 'single') expect(response.status).toBe(409);
        else expect((await response.json()).deleted).toEqual([]);
        expect(rows.get(FIRST)).toEqual(before); expect(countWrites()).toEqual([]);
        expect(folders[client.mailbox.path].get(11)).toBe('<unrelated@test>');
        expect(wire.writes.filter(([epoch]) => epoch !== 7n)).toEqual([]);
        expect(wire.commands).toHaveLength(stage === 'expunge' ? 1 : 0);
        expect(wire.next).toHaveBeenCalledTimes(stage === 'expunge' ? 1 : 0);
      });
    }
    it(`${mode} sends one Deleted STORE then installed compiled EXPUNGE, UIDPLUS=${withUidplus}`, async () => {
      uidplus = withUidplus; client = fakeClient();
      rows = new Map([[FIRST, row(FIRST, 11, '<wanted@test>', 'Trash')]]);
      folders.Trash = new Map([[11, '<wanted@test>'], [99, '<other@test>']]);
      const wire = epochWire('stable');
      const response = await (mode === 'single' ? del(FIRST) : bulk([FIRST]));
      expect(response.status).toBe(200); expect(rows.has(FIRST)).toBe(false);
      expect(wire.writes.filter(([, op, uid]) => op === 'add' && uid === '11')).toHaveLength(1);
      expect(wire.commands).toHaveLength(1); expect(wire.next).toHaveBeenCalledTimes(1);
      expect(client.mailbox.highestModseq).toBe(9007199254740993n);
      expect(folders.Trash.get(99)).toBe('<other@test>');
    });
    it(`${mode} retains local rows after installed exec rejects EXPUNGE, UIDPLUS=${withUidplus}`, async () => {
      uidplus = withUidplus; client = fakeClient();
      rows = new Map([[FIRST, row(FIRST, 11, '<wanted@test>', 'Trash')]]);
      folders.Trash = new Map([[11, '<wanted@test>'], [99, '<other@test>']]);
      const wire = epochWire('server-error');
      const response = await (mode === 'single' ? del(FIRST) : bulk([FIRST]));
      if (mode === 'single') expect(response.status).toBe(500);
      else expect((await response.json()).deleted).toEqual([]);
      expect(rows.has(FIRST)).toBe(true); expect(countWrites()).toEqual([]);
      expect(wire.next).not.toHaveBeenCalled(); expect(wire.commands).toHaveLength(1);
      expect(folders.Trash.get(99)).toBe('<other@test>');
    });
  }
  it('single delete refuses swapped noUIDPLUS Trash UID and retains the row', async () => {
    const first = await swappedTrash();
    expect((await del(first.id)).status).toBe(409);
    expect([...folders.Trash]).toEqual([[10, '<first@test>'], [11, '<second@test>']]);
    expect(rows.has(first.id)).toBe(true);
    expect(countWrites()).toHaveLength(4);
  });
  it('bulk delete refuses swapped noUIDPLUS Trash UIDs and retains both rows', async () => {
    await swappedTrash();
    const ids = [...rows.keys()];
    const response = await bulk(ids);
    expect((await response.json()).deleted).toEqual([]);
    expect(folders.Trash.size).toBe(2);
    expect([...rows.keys()]).toEqual(ids);
  });
  for (const expected of [null, '', '<>', '  <> ', '<reused@test>']) {
    for (const mode of ['single', 'bulk']) {
      it(`${mode} fails closed for missing, degenerate or reused identity ${JSON.stringify(expected)}`, async () => {
        rows = new Map([[FIRST, row(FIRST, 11, expected, 'Trash')]]);
        folders.Trash = new Map([[11, expected], [12, expected]]);
        const response = await (mode === 'single' ? del(FIRST) : bulk([FIRST]));
        if (mode === 'single') expect(response.status).toBe(409);
        else expect((await response.json()).deleted).toEqual([]);
        expect(folders.Trash.size).toBe(2);
        expect(rows.has(FIRST)).toBe(true);
      });
    }
  }
  it.each(['single', 'bulk'])('%s deletes a unique matching UID and preserves unrelated mail', async mode => {
    rows = new Map([[FIRST, row(FIRST, 11, '<first@test>', 'Trash')]]);
    folders.Trash = new Map([[11, '<first@test>'], [12, '<other@test>']]);
    const response = await (mode === 'single' ? del(FIRST) : bulk([FIRST]));
    expect(response.status).toBe(200);
    expect([...folders.Trash]).toEqual([[12, '<other@test>']]);
    expect(rows.has(FIRST)).toBe(false);
  });
  it('an explicitly undefined expectation does not bypass identity verification', async () => {
    folders.Trash.set(11, '<first@test>');
    expect(await imapManager.permanentDeleteMessage(account, 11, 'Trash', { expectMessageId: undefined })).toBe(false);
    expect(folders.Trash.get(11)).toBe('<first@test>');
  });
  for (const withUidplus of [false, true]) {
    for (const mode of ['single', 'bulk']) {
      it(`${mode} keeps rows/counts for a vanished UID with UIDPLUS=${withUidplus}`, async () => {
        uidplus = withUidplus; client = fakeClient();
        rows = new Map([[FIRST, row(FIRST, 11, '<first@test>', 'Trash')]]);
        folders.Trash.set(12, '<other@test>');
        const response = await (mode === 'single' ? del(FIRST) : bulk([FIRST]));
        if (mode === 'single') expect(response.status).toBe(409);
        else expect((await response.json()).deleted).toEqual([]);
        expect(rows.has(FIRST)).toBe(true);
        expect(countWrites()).toEqual([]);
        expect([...folders.Trash]).toEqual([[12, '<other@test>']]);
      });
      it(`${mode} ignores substring candidates and deletes exact unique identity with UIDPLUS=${withUidplus}`, async () => {
        uidplus = withUidplus; client = fakeClient();
        rows = new Map([[FIRST, row(FIRST, 11, 'first@test', 'Trash')]]);
        folders.Trash = new Map([[11, '<first@test>'], [12, '<prefix-first@test>']]);
        expect((await (mode === 'single' ? del(FIRST) : bulk([FIRST]))).status).toBe(200);
        expect([...folders.Trash]).toEqual([[12, '<prefix-first@test>']]);
        expect(rows.has(FIRST)).toBe(false);
      });
    }
    it(`bulk counts/deletes only positively verified targets with UIDPLUS=${withUidplus}`, async () => {
      uidplus = withUidplus; client = fakeClient();
      rows = new Map([row(FIRST, 11, '<first@test>', 'Trash'), row(SECOND, 12, '<second@test>', 'Trash')].map(m => [m.id, m]));
      folders.Trash = new Map([[11, '<first@test>'], [12, '<reused@test>']]);
      const response = await bulk([FIRST, SECOND]);
      expect((await response.json()).deleted).toEqual([FIRST]);
      expect([...folders.Trash]).toEqual([[12, '<reused@test>']]);
      expect([...rows.keys()]).toEqual([SECOND]);
      expect(countWrites().map(([, p]) => p.slice(0, 2))).toEqual([[-1, -1]]);
    });
    it(`bulk partial-expunge recovery never reports an unverified missing UID as deleted with UIDPLUS=${withUidplus}`, async () => {
      uidplus = withUidplus; client = fakeClient();
      rows = new Map([row(FIRST, 11, '<first@test>', 'Trash'), row(SECOND, 12, '<second@test>', 'Trash')].map(m => [m.id, m]));
      folders.Trash = new Map([[11, '<first@test>']]);
      client.exec = async (_command, attributes) => {
        if (uidplus) expect(attributes).toEqual([{ type: 'SEQUENCE', value: '11' }]);
        folders.Trash.delete(11);
        throw new Error('lost tagged reply after expunge');
      };
      const response = await bulk([FIRST, SECOND]);
      expect((await response.json()).deleted).toEqual([FIRST]);
      expect([...rows.keys()]).toEqual([SECOND]);
    });
  }

  it('bulk does not claim deletion when identity verification fails before expunge', async () => {
    rows = new Map([row(FIRST, 11, '<first@test>', 'Trash'), row(SECOND, 12, '<second@test>', 'Trash')].map(m => [m.id, m]));
    folders.Trash = new Map([[11, '<first@test>'], [12, '<second@test>']]);
    const search = client.search;
    client.search = async (...args) => {
      if ((args[0].or || [args[0]]).some(q => q.header?.['Message-ID'] === 'second@test')) {
        folders.Trash.delete(11); // another client removed it; our expunge never ran
        throw new Error('identity verification interrupted');
      }
      return search(...args);
    };
    const response = await bulk([FIRST, SECOND]);
    expect((await response.json()).deleted).toEqual([]);
    expect([...rows.keys()]).toEqual([FIRST, SECOND]);
    expect(countWrites()).toEqual([]);
  });

  it.each([['search', false], ['unflag', false], ['store', false], ['store', true]])(
    'bulk keeps local state when %s fails before any EXPUNGE, UIDPLUS=%s', async (stage, plus) => {
      uidplus = plus; client = fakeClient();
      rows = new Map([[FIRST, row(FIRST, 11, '<wanted@test>', 'Trash')]]);
      folders.Trash = new Map([[11, '<wanted@test>'], [99, '<other@test>']]);
      const before = { ...rows.get(FIRST) }, expunge = vi.spyOn(client, 'exec'), search = client.search;
      let preflight = true;
      const refuse = async () => { folders.Trash.delete(11); return false; }; // external removal, not our EXPUNGE
      client.search = async (...args) => {
        if (args[0].uid && stage === 'search' && preflight) { preflight = false; return refuse(); }
        if (args[0].deleted && stage === 'unflag') return [99];
        return search(...args);
      };
      if (stage === 'unflag') client.messageFlagsRemove = refuse;
      if (stage === 'store') client.messageFlagsAdd = refuse;
      expect((await (await bulk([FIRST])).json()).deleted).toEqual([]);
      expect(expunge).not.toHaveBeenCalled(); expect(rows.get(FIRST)).toEqual(before);
      expect(countWrites()).toEqual([]);
    });

  it.each([null, false, -1, 0, 4294967296, '11:*', [12], 12].map(uid => ({ reply: [uid] })))(
    'bulk refuses malformed recovery UID array $reply after a lost EXPUNGE reply', async ({ reply }) => {
      uidplus = true; client = fakeClient();
      rows = new Map([[FIRST, row(FIRST, 11, '<wanted@test>', 'Trash')]]);
      folders.Trash = new Map([[11, '<wanted@test>']]);
      const before = { ...rows.get(FIRST) }, search = client.search;
      let dispatched = false;
      client.exec = vi.fn(async () => { dispatched = true; throw new Error('lost EXPUNGE response'); });
      client.search = async (...args) => args[0].uid && dispatched ? reply : search(...args);
      expect((await (await bulk([FIRST])).json()).deleted).toEqual([]);
      expect(client.exec).toHaveBeenCalledTimes(1); expect(folders.Trash.get(11)).toBe('<wanted@test>');
      expect(rows.get(FIRST)).toEqual(before); expect(countWrites()).toEqual([]);
    });

  it('reports an explicit safe refusal instead of an opaque server error', async () => {
    rows = new Map([[FIRST, row(FIRST, 11, null, 'Trash')]]);
    folders.Trash.set(11, null);
    const response = await del(FIRST);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('message_identity_unverified');
    expect(rows.has(FIRST)).toBe(true);
  });
  it('does not log an identity refusal as an IMAP delete failure', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    rows = new Map([[FIRST, row(FIRST, 11, null, 'Trash')]]);
    folders.Trash.set(11, null);
    const response = await bulk([FIRST]);
    expect(await response.json()).toMatchObject({ deleted: [], unverified: [FIRST] });
    expect(errors.mock.calls.filter(([message]) => String(message).includes('IMAP delete failed'))).toEqual([]);
  });
  it('bulk distinguishes identity refusals from deleted rows', async () => {
    rows = new Map([[FIRST, row(FIRST, 11, null, 'Trash')]]);
    folders.Trash.set(11, null);
    const response = await bulk([FIRST]);
    expect(await response.json()).toMatchObject({ deleted: [], unverified: [FIRST] });
    expect(rows.has(FIRST)).toBe(true);
  });

  for (const malformed of ['<@>', '<x@>', '<@x>']) {
    for (const folder of ['Trash', 'Drafts']) {
      for (const mode of ['single', 'bulk']) {
        for (const withUidplus of [false, true]) {
          it(`${mode} refuses one unique malformed ID ${malformed} in ${folder}, UIDPLUS=${withUidplus}`, async () => {
            uidplus = withUidplus; client = fakeClient();
            rows = new Map([[FIRST, row(FIRST, 11, malformed, folder)]]);
            folders[folder] = new Map([[11, malformed]]); // exactly one candidate, not duplicate rejection
            const before = { ...rows.get(FIRST) };
            const expunge = vi.spyOn(client, 'messageDelete');
            const store = vi.spyOn(client, 'messageFlagsAdd');
            const response = await (mode === 'single' ? del(FIRST) : bulk([FIRST]));
            if (mode === 'single') {
              expect(response.status).toBe(409);
              expect((await response.json()).code).toBe('message_identity_unverified');
            } else {
              expect(await response.json()).toMatchObject({ deleted: [], unverified: [FIRST] });
            }
            expect(expunge).not.toHaveBeenCalled();
            expect(store).not.toHaveBeenCalled();
            expect([...folders[folder]]).toEqual([[11, malformed]]);
            expect(rows.get(FIRST)).toEqual(before);
            expect(countWrites()).toEqual([]);
          });
        }
      }
    }
  }
  it.each(['Trash', 'Drafts'])('a real permanentDeleteMessage false keeps the %s route row and counts intact', async folder => {
    rows = new Map([[FIRST, row(FIRST, 11, '<wanted@test>', folder)]]);
    folders[folder] = new Map([[11, '<different@test>']]);
    const before = { ...rows.get(FIRST) };
    const expunge = vi.spyOn(client, 'messageDelete');
    expect(await imapManager.permanentDeleteMessage(account, 11, folder, { expectMessageId: '<wanted@test>' })).toBe(false);
    const response = await del(FIRST);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('message_identity_unverified');
    expect(expunge).not.toHaveBeenCalled();
    expect([...folders[folder]]).toEqual([[11, '<different@test>']]);
    expect(rows.get(FIRST)).toEqual(before);
    expect(countWrites()).toEqual([]);
  });

  function manyMessages() {
    uidplus = true; client = fakeClient();
    const messages = Array.from({ length: 500 }, (_, i) => row(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, 1001 + i, `<bulk${i}@test>`, 'Trash'));
    rows = new Map(messages.map(m => [m.id, m]));
    folders.Trash = new Map(messages.map(m => [m.uid, m.message_id]));
    return messages;
  }
  it('compiles500 bulk identities as25 OR HEADER searches and5 candidate FETCHes', async () => {
    const messages = manyMessages();
    const response = await bulk(messages.map(m => m.id));
    expect((await response.json()).deleted).toHaveLength(500);
    expect(folders.Trash.size).toBe(0);
    expect(searchCommands).toHaveLength(25);
    expect(fetchCommands).toHaveLength(5);
    for (const command of searchCommands) {
      expect(command.filter(a => a === 'HEADER')).toHaveLength(20);
      expect(command.filter(a => a === 'MESSAGE-ID')).toHaveLength(20);
      expect(command.filter(a => a === 'OR')).toHaveLength(19);
    }
  });
  it('bulk rejects a reused identity outside the selectedUID set while deleting verified peers', async () => {
    const messages = manyMessages();
    folders.Trash.set(9999, messages[0].message_id);
    const response = await bulk(messages.map(m => m.id));
    expect((await response.json()).deleted).toEqual(messages.slice(1).map(m => m.id));
    expect([...folders.Trash]).toEqual([[messages[0].uid, messages[0].message_id], [9999, messages[0].message_id]]);
    expect([...rows.keys()]).toEqual([messages[0].id]);
    expect(searchCommands).toHaveLength(25);
    expect(fetchCommands).toHaveLength(6);
  });
  it('rejects exact duplicates across FETCH chunks rather than accepting the first match', async () => {
    uidplus = true; client = fakeClient();
    rows = new Map([[FIRST, row(FIRST, 11, '<target@test>', 'Trash')]]);
    folders.Trash = new Map([[11, '<target@test>'], ...Array.from({ length: 200 }, (_, i) => [1000 + i, `<prefix${i}-target@test>`]), [9999, '<target@test>']]);
    const response = await bulk([FIRST]);
    expect((await response.json()).deleted).toEqual([]);
    expect(folders.Trash.size).toBe(202); expect(rows.has(FIRST)).toBe(true);
    expect(fetchCommands).toHaveLength(3);
    expect(countWrites()).toEqual([]);
  });
  for (const reply of [false, [[11]], [11, 4294967296], Array.from({ length: 2001 }, (_, i) => i + 1)]) {
    it(`fails closed before expunge on invalid or over-budget SEARCH result (size=${reply.length ?? 'nonarray'})`, async () => {
      rows = new Map([[FIRST, row(FIRST, 11, '<first@test>', 'Trash')]]);
      folders.Trash.set(11, '<first@test>');
      client.search = async () => reply;
      const expunge = vi.spyOn(client, 'messageDelete');
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {}); let failures;
      const response = await bulk([FIRST]).finally(() => {
        failures = errors.mock.calls.filter(args => args.some(arg => String(arg).includes('IMAP delete failed'))); errors.mockRestore();
      });
      expect(await response.json()).toMatchObject({ deleted: [], unverified: [FIRST] });
      expect(failures).toEqual([]);
      expect(expunge).not.toHaveBeenCalled(); expect(fetchCommands).toEqual([]);
      expect(rows.has(FIRST)).toBe(true); expect(folders.Trash.get(11)).toBe('<first@test>');
      expect(countWrites()).toEqual([]);
    });
  }

});
