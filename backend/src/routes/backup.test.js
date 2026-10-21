import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'http';
import { randomBytes } from 'crypto';
import { gzipSync } from 'zlib';

vi.mock('../services/db.js', () => ({
  query: vi.fn(),
  pool: { connect: vi.fn() },
  withTransaction: vi.fn(),
}));
vi.mock('../services/aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAdmin: (req, _res, next) => {
    req.session = { userId: 'admin-1', username: 'admin' };
    next();
  },
}));
// `actual` is the module the mock's BackupFileError comes from, so a test that runs the real
// restore gets errors the router recognises.
vi.mock('../services/backup.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, actual, writeBackup: vi.fn(), restoreBackup: vi.fn(), unclassifiedTables: vi.fn() };
});
vi.mock('../services/encryption.js', () => ({
  encrypt: value => 'enc:' + value,
  decrypt: value => typeof value === 'string' && value.startsWith('enc:') ? value.slice(4) : value,
  isEncrypted: value => typeof value === 'string' && value.startsWith('enc:'),
}));
vi.mock('../index.js', () => ({
  APP_VERSION: '3.6.0',
  imapManager: { disconnectUser: vi.fn(async () => {}), connectAllForUser: vi.fn(async () => {}),
    quiesceSearchIndex: vi.fn(async () => {}), resumeSearchIndexScheduling: vi.fn() },
  restartAfterRestore: vi.fn(),
}));

import express from 'express';
import { ImapManager } from '../services/imapManager.js';
import { createSearchIndexLifecycle } from '../services/searchIndexLifecycle.js';
import { createSearchIndexWindowTracker } from '../services/searchIndexWindow.js';

let server;
let base;
let port;
const client = { release: vi.fn(), query: vi.fn() };

// A committed restore keeps the router's restore slot taken until the process restarts, which
// the mock never does, so every test gets a fresh router, and the mocks it was built with.
let m;
beforeAll(async () => {
  const app = express();
  app.use('/api/admin/backup', (req, res, next) => m.router(req, res, next));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
  base = `http://127.0.0.1:${port}/api/admin/backup`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
  vi.resetModules();
  m = {
    db: await import('../services/db.js'),
    backup: await import('../services/backup.js'),
    index: await import('../index.js'),
    router: (await import('./backup.js')).default,
  };
  vi.clearAllMocks();
  client.query.mockReset().mockResolvedValue({ rows: [] });
  m.index.imapManager.disconnectUser.mockReset().mockResolvedValue();
  m.index.imapManager.connectAllForUser.mockReset().mockResolvedValue();
  m.index.imapManager.quiesceSearchIndex.mockReset().mockResolvedValue();
  m.index.imapManager.resumeSearchIndexScheduling.mockReset();
  m.db.pool.connect.mockResolvedValue(client);
  m.db.query.mockResolvedValue({ rows: [{ id: 'u1' }, { id: 'u2' }] });
  m.backup.unclassifiedTables.mockResolvedValue([]);
});

const wait = ms => new Promise(r => setTimeout(r, ms));
const post = (body, type = 'application/gzip') => fetch(`${base}/restore`, { method: 'POST', headers: { 'Content-Type': type }, body });
const ndjson = async res => (await res.text()).trim().split('\n').map(l => JSON.parse(l));
const RESULT = { scope: 'setup', tables: 1, rows: 2, warnings: [] };

describe('GET /api/admin/backup/check', () => {
  it('says whether a backup can start', async () => {
    expect((await fetch(`${base}/check?scope=full`)).status).toBe(200);
    m.backup.unclassifiedTables.mockResolvedValue(['brand_new_table']);
    const res = await fetch(`${base}/check?scope=full`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Tables not classified for backup: brand_new_table' });
  });
});

describe('GET /api/admin/backup', () => {
  it('streams the backup as a gzip download named after the moment and scope', async () => {
    m.backup.writeBackup.mockImplementation(async (_client, { out }) => { out.write('gz'); out.end(); return { tables: 2, rows: 5 }; });
    const res = await fetch(`${base}?scope=full`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/gzip');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="mailflow-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-full\.json\.gz"$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('gz');
    expect(m.backup.writeBackup).toHaveBeenCalledWith(client, expect.objectContaining({ scope: 'full', appVersion: '3.6.0' }));
    expect(client.release).toHaveBeenCalled();
  });

  it('backs up the setup by default', async () => {
    m.backup.writeBackup.mockImplementation(async (_client, { out }) => { out.end(); return { tables: 0, rows: 0 }; });
    await fetch(base);
    expect(m.backup.writeBackup.mock.calls[0][1].scope).toBe('setup');
  });

  it('rejects an unknown scope', async () => {
    const res = await fetch(`${base}?scope=everything`);
    expect(res.status).toBe(400);
    expect(m.backup.writeBackup).not.toHaveBeenCalled();
  });

  it('refuses a download another site started', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const res = await fetch(base, { headers: { 'Sec-Fetch-Site': site } });
      expect(res.status).toBe(403);
    }
    expect(m.backup.writeBackup).not.toHaveBeenCalled();
    m.backup.writeBackup.mockImplementation(async (_client, { out }) => { out.end(); return { tables: 0, rows: 0 }; });
    expect((await fetch(base, { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(200);
  });

  it('answers a failure before the first byte as JSON, not as a download', async () => {
    m.backup.writeBackup.mockRejectedValue(new Error('Tables not classified for backup: x'));
    const res = await fetch(base);
    expect(res.status).toBe(500);
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ error: 'Tables not classified for backup: x' });
    expect(client.release).toHaveBeenCalled();
  });
});

describe('POST /api/admin/backup/restore', () => {
  it('waits for global index quiescence before disconnecting any user', async () => {
    let finish;
    const drain = new Promise(resolve => { finish = resolve; });
    const order = [];
    m.index.imapManager.quiesceSearchIndex.mockImplementation(async () => { await drain; order.push('drained'); });
    m.index.imapManager.disconnectUser.mockImplementation(async id => { order.push(id); });
    m.backup.restoreBackup.mockImplementation(async (_client, _input, { beforeWrite }) => {
      await beforeWrite(); throw new Error('stop after beforeWrite');
    });
    const restoring = post('gz-bytes');
    try {
      await vi.waitFor(() => expect(m.index.imapManager.quiesceSearchIndex).toHaveBeenCalledOnce());
      expect(order).toEqual([]);
      finish();
      expect(await ndjson(await restoring)).toEqual([{ error: 'stop after beforeWrite' }]);
      expect(order).toEqual(['drained', 'u1', 'u2']);
    } finally { finish(); await restoring; }
  });

  it.each(['global drain', 'user fence'])('prevents actual restore BEGIN and TRUNCATE after a failed %s', async failure => {
    const order = [], statements = [];
    client.query.mockImplementation(async text => {
      statements.push(text);
      if (text.startsWith('SELECT version FROM schema_migrations')) return { rows: [{ version: '0075_search_index_jobs' }] };
      return { rows: [] };
    });
    m.index.imapManager.quiesceSearchIndex.mockImplementation(async () => {
      if (failure === 'global drain') throw new Error('index drain failed');
    });
    if (failure === 'user fence') {
      // The real ordinary path contains this failure; only the route forwarding
      // strict:true makes beforeWrite reject. A throwing double misses that bug.
      const manager = Object.create(ImapManager.prototype);
      for (const name of ['connections', 'syncIntervals', 'pluginSyncIntervals', 'syncThrottleSkips', 'syncTickCount',
        'lastSyncOkAt', '_idleMissStreak', '_syncErrorState', '_pendingFlagSync', '_pendingNewMail',
        '_flagDebounceTimers', '_expungeDebounceTimers']) manager[name] = new Map();
      manager._pollOnlyAccounts = new Set();
      manager._searchIndex = createSearchIndexLifecycle({
        runBatch: async () => { throw new Error('Unexpected index activation'); },
        invalidateRun: async () => { throw new Error('index fence failed'); },
      });
      m.index.imapManager.disconnectUser.mockImplementation(manager.disconnectUser.bind(manager));
    }
    m.index.imapManager.resumeSearchIndexScheduling.mockImplementation(() => { order.push('scheduling'); });
    m.index.imapManager.connectAllForUser.mockImplementation(async id => { order.push(id); });
    m.backup.restoreBackup.mockImplementation(m.backup.actual.restoreBackup);
    const manifest = { mailflow: 'backup', format: m.backup.BACKUP_FORMAT, scope: 'setup',
      schemaVersion: '0075_search_index_jobs', tables: [], sequences: {}, keyCheck: 'enc:mailflow-backup-key-check' };
    const response = await post(gzipSync(JSON.stringify(manifest) + '\n' + JSON.stringify({ end: true, rowCounts: {} }) + '\n'));
    expect(await ndjson(response)).toEqual([{ error: failure === 'global drain' ? 'index drain failed' : 'index fence failed' }]);
    expect(statements).not.toContain('BEGIN');
    expect(statements.some(text => text.includes('TRUNCATE'))).toBe(false);
    await vi.waitFor(() => expect(order).toEqual(['scheduling', 'u1', 'u2']));
    expect(m.index.restartAfterRestore).not.toHaveBeenCalled();
  });

  it('streams progress, then the result, and restarts once the reply is out', async () => {
    m.backup.restoreBackup.mockImplementation(async (_client, input, { beforeWrite, onProgress }) => {
      expect(typeof input.pipe).toBe('function');
      await beforeWrite();
      onProgress({ table: 'users', rows: 2 });
      return { ...RESULT, warnings: ['note'] };
    });
    const res = await post('gz-bytes');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(await ndjson(res)).toEqual([{ table: 'users', rows: 2 }, { ok: true, ...RESULT, warnings: ['note'] }]);
    expect(m.index.imapManager.disconnectUser.mock.calls.map(c => c[0])).toEqual(['u1', 'u2']);
    expect(m.index.imapManager.connectAllForUser).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(m.index.restartAfterRestore).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(client.release).toHaveBeenCalled();
  });

  it('keeps date discovery and committed-id handoff stopped after a committed restore until restart',async()=>{
    const account={id:'restore-index-account'},produce=vi.fn(async()=>{}),handoff=vi.fn(async()=>{});
    const lifecycle=createSearchIndexLifecycle({runBatch:produce,invalidateRun:async()=>{}});
    const manager=Object.create(ImapManager.prototype);manager._searchIndex=lifecycle;
    manager._searchIndexSources=Object.assign(produce,{enqueueRows:handoff,rescan:()=>{}});
    await lifecycle.resume(account.id);
    m.index.imapManager.quiesceSearchIndex.mockImplementation(()=>lifecycle.quiesce());
    m.backup.restoreBackup.mockImplementation(async(_client,_input,{beforeWrite})=>{await beforeWrite();return RESULT;});
    expect(await ndjson(await post('gz-bytes'))).toEqual([{ok:true,...RESULT}]);
    expect(await manager.startSearchIndex(account)).toBeNull();
    expect(await manager.enqueueCommittedSearchRows(account,['00000000-0000-4000-8000-000000000001']))
      .toMatchObject({deferred:true,reason:'stopped'});
    expect(produce).not.toHaveBeenCalled();expect(handoff).not.toHaveBeenCalled();
    expect(m.index.imapManager.resumeSearchIndexScheduling).not.toHaveBeenCalled();
    await vi.waitFor(()=>expect(m.index.restartAfterRestore).toHaveBeenCalledTimes(1),{timeout:3000});
    expect((await post('gz-bytes')).status).toBe(409);expect(lifecycle.isOpen(account.id)).toBe(false);
  });

  it('resumes a newest rescan after a failed restore and the prior disconnect epoch change',async()=>{
    const account={id:'restore-index-account'},tracker=createSearchIndexWindowTracker();let epoch=10n;
    const rows=[{id:'b',cursor_date:'2026-10-21T00:00:00.000001Z'},{id:'a',cursor_date:'2026-10-21T00:00:00.000000Z'}];
    tracker.commit(tracker.next(account.id,2,String(epoch)),rows);
    tracker.commit(tracker.next(account.id,2,String(epoch)),[{id:'9',cursor_date:null},{id:'8',cursor_date:null}]);
    const lifecycle=createSearchIndexLifecycle({runBatch:async()=>tracker.next(account.id,2,String(epoch)),invalidateRun:async()=>{epoch++;}});
    await lifecycle.resume(account.id);
    m.index.imapManager.quiesceSearchIndex.mockImplementation(()=>lifecycle.quiesce());
    m.index.imapManager.resumeSearchIndexScheduling.mockImplementation(()=>lifecycle.resumeScheduling());
    m.index.imapManager.connectAllForUser.mockImplementation(()=>lifecycle.resume(account.id));
    m.backup.restoreBackup.mockImplementation(async(_client,_input,{beforeWrite})=>{await beforeWrite();throw new Error('simulated restore rollback');});
    expect(await ndjson(await post('gz-bytes'))).toEqual([{error:'simulated restore rollback'}]);
    await vi.waitFor(()=>expect(lifecycle.isOpen(account.id)).toBe(true));
    const next=await lifecycle.run(account);expect(next).toMatchObject({track:'newest',after:null,above:null});
    tracker.commit(next,rows);expect(tracker.next(account.id,2,String(epoch))).toMatchObject({track:'older',after:{id:'8'}});
    expect(epoch).toBe(11n);expect(m.index.restartAfterRestore).not.toHaveBeenCalled();
  });

  it('still restarts when the browser went away before the result reached it', async () => {
    m.backup.restoreBackup.mockImplementation(async (_client, _input, { beforeWrite }) => {
      await beforeWrite();
      await wait(200);
      return RESULT;
    });
    await new Promise(resolve => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/api/admin/backup/restore', method: 'POST', headers: { 'Content-Type': 'application/gzip' } });
      req.on('response', () => { req.destroy(); resolve(); });
      req.on('error', () => {});
      req.end('gz-bytes');
    });
    await vi.waitFor(() => expect(m.index.restartAfterRestore).toHaveBeenCalledTimes(1), { timeout: 4000 });
  });

  it('answers a bad file with 400 and the reason, without restarting', async () => {
    m.backup.restoreBackup.mockRejectedValue(new m.backup.BackupFileError('This backup was made on a server with a different ENCRYPTION_KEY.'));
    const res = await post('gz-bytes');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'This backup was made on a server with a different ENCRYPTION_KEY.' });
    await wait(600);
    expect(m.index.restartAfterRestore).not.toHaveBeenCalled();
    expect(m.index.imapManager.disconnectUser).not.toHaveBeenCalled();
  });

  it('answers a refused upload even when most of it is still unread', async () => {
    m.backup.restoreBackup.mockImplementation(m.backup.actual.restoreBackup);
    client.query.mockResolvedValue({ rows: [{ version: '0061_message_bcc_addresses' }] });
    const manifest = { mailflow: 'backup', format: m.backup.BACKUP_FORMAT, scope: 'setup', schemaVersion: '0999_future', tables: [], sequences: {}, keyCheck: 'enc:x' };
    const filler = Array.from({ length: 80 }, () => JSON.stringify({ table: 'users', rows: [{ id: 'u', username: randomBytes(30000).toString('base64') }] }));
    const res = await post(gzipSync([JSON.stringify(manifest), ...filler].join('\n')));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/newer version/);
    // The next restore is not refused as "already running".
    m.backup.restoreBackup.mockRejectedValue(new m.backup.BackupFileError('nope'));
    expect((await post('gz-bytes')).status).toBe(400);
  });

  it('reports a failure after the write began inside the stream and reconnects the accounts', async () => {
    m.backup.restoreBackup.mockImplementation(async (_client, _input, { beforeWrite }) => { await beforeWrite(); throw new Error('lock timeout'); });
    const res = await post('gz-bytes');
    expect(res.status).toBe(200);
    expect(await ndjson(res)).toEqual([{ error: 'lock timeout' }]);
    await vi.waitFor(() => expect(m.index.imapManager.connectAllForUser.mock.calls.map(c => c[0])).toEqual(['u1', 'u2']));
    await wait(600);
    expect(m.index.restartAfterRestore).not.toHaveBeenCalled();
  });

  it('frees the restore slot when no database connection can be had', async () => {
    m.db.pool.connect.mockRejectedValueOnce(new Error('pool exhausted'));
    const res = await post('gz-bytes');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'pool exhausted' });
    m.backup.restoreBackup.mockResolvedValue(RESULT);
    expect((await post('gz-bytes')).status).toBe(200);
  });

  it('wants the file as application/gzip', async () => {
    const res = await post('{}', 'application/json');
    expect(res.status).toBe(415);
    expect(m.backup.restoreBackup).not.toHaveBeenCalled();
  });

  it('runs one restore at a time and holds backups off meanwhile', async () => {
    let finish;
    m.backup.restoreBackup.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = post('gz-bytes');
    await vi.waitFor(() => expect(m.backup.restoreBackup).toHaveBeenCalled());
    expect((await post('gz-bytes')).status).toBe(409);
    expect((await fetch(base)).status).toBe(409);
    expect((await fetch(`${base}/check`)).status).toBe(409);
    finish(RESULT);
    expect((await first).status).toBe(200);
    expect(m.backup.restoreBackup).toHaveBeenCalledTimes(1);
    // After a committed restore the process is about to restart, so the slot stays taken.
    expect((await post('gz-bytes')).status).toBe(409);
  });

  it('waits for a running download instead of racing its locks', async () => {
    let finishDownload;
    m.backup.writeBackup.mockImplementation(async (_client, { out }) => {
      out.write('gz');
      await new Promise(resolve => { finishDownload = resolve; });
      out.end();
      return { tables: 1, rows: 1 };
    });
    const download = fetch(base).then(res => res.text());
    await vi.waitFor(() => expect(m.backup.writeBackup).toHaveBeenCalled());
    const refused = await post('gz-bytes');
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/download is running/);
    expect(m.backup.restoreBackup).not.toHaveBeenCalled();
    finishDownload();
    await download;
    m.backup.restoreBackup.mockResolvedValue(RESULT);
    expect((await post('gz-bytes')).status).toBe(200);
  });

  it('lifts the request time limit only while a restore reads its upload', async () => {
    const before = server.requestTimeout;
    expect(before).toBeGreaterThan(0);
    let during;
    m.backup.restoreBackup.mockImplementation(async () => { during = server.requestTimeout; return RESULT; });
    await (await post('gz-bytes')).text();
    expect(during).toBe(0);
    expect(server.requestTimeout).toBe(before);
    m.backup.restoreBackup.mockRejectedValue(new m.backup.BackupFileError('nope'));
    await (await post('gz-bytes')).text();
    expect(server.requestTimeout).toBe(before);
  });

  it('explains a restore that gave up on a busy lock', async () => {
    m.backup.restoreBackup.mockImplementation(async (_client, _input, { beforeWrite }) => {
      await beforeWrite();
      throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    });
    const res = await post('gz-bytes');
    expect(await ndjson(res)).toEqual([{ error: 'Another connection kept MailFlow’s tables busy for 30 seconds. Nothing was changed; try again.' }]);
  });
});
