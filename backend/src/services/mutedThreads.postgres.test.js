import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import express from 'express';
import 'express-async-errors';
const h = vi.hoisted(() => ({ pool: null }));
vi.mock('./db.js', () => ({
  pool: { connect: (...args) => h.pool.connect(...args) },
  query: (...args) => h.pool.query(...args),
  withTransaction: async fn => {
    const client = await h.pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  },
}));
vi.mock('./lastSeen.js', () => ({ touchLastSeen: vi.fn() }));
import { runMigrations } from './migrations.js';
import { getMutedThread, listMutedThreads, mutedAlertIds, muteIdentifiers, setMutedThread, verifyMutedArchive } from './mutedThreads.js';
import router from '../routes/mutedThreads.js';
import { SETUP_TABLES } from './backup.js';
const URL = process.env.MAILFLOW_TEST_DATABASE_URL;

it('uses only bounded stable RFC identities and preserves significant case', () => {
  expect(muteIdentifiers([{ message_id: '<A@sample.example>', thread_references: '<root@sample.example> <A@sample.example>' }])).toEqual(['<A@sample.example>', '<root@sample.example>']);
  expect(() => muteIdentifiers([{ message_id: 'subject-derived' }])).toThrow(/stable/);
  expect(() => muteIdentifiers([{ thread_references: 'x'.repeat(16385) }])).toThrow(/too much/);
  expect(() => muteIdentifiers(Array.from({ length: 513 }, (_, i) => ({ message_id: `<${i}@sample.example>` })))).toThrow(/too large/);
  expect(SETUP_TABLES).toContain('muted_threads');
});
describe.skipIf(!URL)('native muted threads with disposable PostgreSQL', () => {
  const dbName = `mailflow_mute_${randomBytes(4).toString('hex')}`;
  let admin, user, other, account, second, foreign, first, reply, unrelated, server, base, uid = 0;
  const message = async (accountId, messageId, threadId = messageId, extra = {}) => (await h.pool.query(`INSERT INTO messages(account_id,uid,folder,message_id,thread_id,in_reply_to,thread_references,subject,date)
    VALUES($1,$2,$3,$4,$5,$6,$7,'Same harmless subject',NOW()) RETURNING *`, [accountId, ++uid, extra.folder || 'INBOX', messageId, threadId, extra.inReplyTo || null, extra.references || null])).rows[0];
  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    admin = new pg.Client({ connectionString: URL }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new globalThis.URL(URL); url.pathname = `/${dbName}`; h.pool = new pg.Pool({ connectionString: url.toString(), max: 8 }); await runMigrations();
    user = (await h.pool.query("INSERT INTO users(username) VALUES('owner') RETURNING id")).rows[0].id;
    other = (await h.pool.query("INSERT INTO users(username) VALUES('other') RETURNING id")).rows[0].id;
    const add = async (owner, name) => (await h.pool.query("INSERT INTO email_accounts(user_id,name,email_address,enabled) VALUES($1,$2,$3,true) RETURNING id", [owner, name, `${name}@sample.example`])).rows[0].id;
    account = await add(user, 'work'); second = await add(user, 'personal'); foreign = await add(other, 'foreign');
    const app = express(); app.use(express.json()); app.use((req,res,next) => { req.session = { userId: req.get('x-test-owner') || user }; next(); }); app.use('/api/mail', router);
    // eslint-disable-next-line no-unused-vars
    app.use((error,req,res,next) => res.status(error.status || 500).json({ error: error.message }));
    await new Promise(resolve => { server = app.listen(0,'127.0.0.1',resolve); }); base=`http://127.0.0.1:${server.address().port}/api/mail`;
  });
  afterAll(async () => { server?.closeAllConnections(); if(server) await new Promise(resolve => server.close(resolve)); await h.pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin?.end(); vi.restoreAllMocks(); });
  beforeEach(async () => {
    await h.pool.query('DELETE FROM muted_threads'); await h.pool.query('DELETE FROM messages'); await h.pool.query('UPDATE email_accounts SET enabled=true');
    first = await message(account,'<root@sample.example>'); reply = await message(account,'<reply@sample.example>','<root@sample.example>',{inReplyTo:'<root@sample.example>', references:'<root@sample.example>'});
    unrelated = await message(account,'<unrelated@sample.example>');
  });
  const mute = async (id=first.id) => setMutedThread(user,id,{muted:true,revision:(await getMutedThread(user,id)).revision});
  it('enforces owner/account identity, CAS and persisted state without moving or marking mail', async () => {
    expect(await getMutedThread(user,first.id)).toMatchObject({muted:false,revision:null});
    const result = await mute(); expect(result.muted).toBe(true); expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(await getMutedThread(user,reply.id)).toEqual(result);
    await expect(setMutedThread(user,first.id,{muted:false,revision:null})).rejects.toMatchObject({status:409});
    await expect(getMutedThread(other,first.id)).rejects.toMatchObject({status:404});
    await expect(listMutedThreads(user,{accountId:foreign})).rejects.toMatchObject({status:404});
    expect((await h.pool.query('SELECT folder,is_read FROM messages WHERE id=$1',[first.id])).rows[0]).toEqual({folder:'INBOX',is_read:false});
    expect((await listMutedThreads(user)).messages).toHaveLength(1); expect((await listMutedThreads(other)).messages).toEqual([]);
    expect((await listMutedThreads(user,{accountId:second})).messages).toEqual([]);
    const unmuted=await setMutedThread(user,reply.id,{muted:false,revision:result.revision}); expect(unmuted.muted).toBe(false); expect((await listMutedThreads(user)).messages).toEqual([]);
  });
  it('serializes absent-record races and preserves a single winning mutation', async () => {
    const results=await Promise.allSettled(Array.from({length:8},()=>setMutedThread(user,first.id,{muted:true,revision:null})));
    expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1); expect(results.filter(x=>x.status==='rejected').every(x=>x.reason.status===409)).toBe(true);
    expect((await h.pool.query('SELECT COUNT(*)::int AS n FROM muted_threads')).rows[0].n).toBe(1);
  });
  it('survives cache moves, thread reparenting and observed merged roots without cross-account leakage', async () => {
    await mute(); await mute(unrelated.id);
    await h.pool.query("UPDATE messages SET folder='Archive',thread_id='<healed@sample.example>' WHERE account_id=$1",[account]);
    const merged=await getMutedThread(user,reply.id); expect(merged.muted).toBe(true);
    await setMutedThread(user,reply.id,{muted:false,revision:merged.revision});
    expect((await h.pool.query('SELECT muted FROM muted_threads')).rows.every(x=>!x.muted)).toBe(true);
    const copy=await message(second,'<root@sample.example>'); expect((await getMutedThread(user,copy.id)).muted).toBe(false);
  });
  it('suppresses only matching future thread alerts, including surviving replies after old cache expunge', async () => {
    await mute(); const incoming=await message(account,'<new@sample.example>','<root@sample.example>',{inReplyTo:'<reply@sample.example>'});
    const copied=await message(second,'<root@sample.example>');
    expect(await mutedAlertIds(account,[incoming.id,unrelated.id,copied.id])).toEqual(new Set([incoming.id]));
    await h.pool.query('DELETE FROM messages WHERE id=ANY($1::uuid[])',[[first.id,reply.id]]);
    expect(await mutedAlertIds(account,[incoming.id])).toEqual(new Set([incoming.id]));
    expect((await listMutedThreads(user)).messages[0].id).toBe(incoming.id);
  });
  it('uses surviving References anchors consistently after cached ancestors disappear', async () => {
    await mute();
    await h.pool.query('DELETE FROM messages WHERE id=ANY($1::uuid[])', [[first.id, reply.id]]);
    const incoming = await message(account, '<survivor@sample.example>', '<earlier-root@sample.example>', {
      inReplyTo: '<uncached-parent@sample.example>',
      references: '<earlier-root@sample.example> <root@sample.example> <uncached-parent@sample.example>',
    });
    expect((await getMutedThread(user, incoming.id)).muted).toBe(true);
    expect.soft(await mutedAlertIds(account, [incoming.id, unrelated.id])).toEqual(new Set([incoming.id]));
    expect.soft((await listMutedThreads(user)).messages.map(row => row.id)).toEqual([incoming.id]);
  });
  it('matches References tokens exactly, preserving case, account boundaries and parsing bounds', async () => {
    await mute();
    await h.pool.query('DELETE FROM messages WHERE id=ANY($1::uuid[])', [[first.id, reply.id]]);
    const rows = [];
    for (const [i, references] of [
      '<prefix-root@sample.example>', '<root@sample.example.suffix>', '<ROOT@sample.example>',
      'root@sample.example', '<root @sample.example>', 'x'.repeat(16385) + ' <root@sample.example>',
    ].entries()) rows.push(await message(account, `<negative-${i}@sample.example>`, undefined, { references }));
    const foreignCopy = await message(second, '<other-account@sample.example>', undefined, { references: '<root@sample.example>' });
    const valid = await message(account, '<valid-reference@sample.example>', undefined, { references: '<unknown@sample.example>\r\n\t<root@sample.example>' });
    expect(await mutedAlertIds(account, [...rows, foreignCopy, valid].map(row => row.id))).toEqual(new Set([valid.id]));
    expect(await mutedAlertIds(second, [foreignCopy.id])).toEqual(new Set());
    expect((await listMutedThreads(user)).messages.map(row => row.id)).toEqual([valid.id]);
  });
  it('rejects deleted, disabled, malformed and oversized targets without widening scope', async () => {
    await expect(setMutedThread(user,'bad',{muted:true,revision:null})).rejects.toMatchObject({status:404});
    await expect(setMutedThread(user,first.id,{muted:true})).rejects.toMatchObject({status:400});
    await h.pool.query('UPDATE messages SET is_deleted=true WHERE id=$1',[first.id]); await expect(getMutedThread(user,first.id)).rejects.toMatchObject({status:404});
    await h.pool.query('UPDATE email_accounts SET enabled=false WHERE id=$1',[account]); await expect(getMutedThread(user,reply.id)).rejects.toMatchObject({status:404});
    expect((await listMutedThreads(user)).messages).toEqual([]);
    await h.pool.query('UPDATE email_accounts SET enabled=true WHERE id=$1',[account]);
    await h.pool.query("UPDATE messages SET thread_references=$1 WHERE id=$2",['x'.repeat(16385),reply.id]);
    await expect(getMutedThread(user,reply.id)).rejects.toMatchObject({status:413});
  });
  it('paginates summaries and excludes message bodies and foreign accounts', async () => {
    for(let i=0;i<102;i++){const m=await message(account,`<page-${i}@sample.example>`); await mute(m.id);}
    const page=await listMutedThreads(user); expect(page.messages).toHaveLength(100); expect(page.hasMore).toBe(true); expect(page.nextOffset).toBe(100); expect(page.messages[0]).not.toHaveProperty('body_html');
    const tail=await listMutedThreads(user,{offset:100}); expect(tail.messages).toHaveLength(2); expect(tail.hasMore).toBe(false);
    await expect(listMutedThreads(user,{offset:-1})).rejects.toMatchObject({status:400});
  });
  it('serves the exact GET/PATCH contract and rejects invalid query shapes', async () => {
    const path=`${base}/messages/${first.id}/mute`;
    expect(await (await fetch(path)).json()).toMatchObject({muted:false,revision:null});
    const changed=await fetch(path,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({muted:true,revision:null,userId:other})}); expect(changed.status).toBe(200);
    expect((await (await fetch(`${base}/muted`)).json()).messages).toHaveLength(1);
    expect((await fetch(`${base}/muted?offset=1x`)).status).toBe(400);
    expect((await fetch(path,{headers:{'x-test-owner':other}})).status).toBe(404);
  });
  it('guards mute-then-archive against stale revisions, other threads/accounts and moved messages', async () => {
    const saved=await mute(); const guard={messageId:first.id,accountId:account,threadKey:saved.threadKey,revision:saved.revision};
    expect(await verifyMutedArchive(user,[first.id,reply.id],guard)).toBe(true);
    await expect(verifyMutedArchive(user,[first.id,unrelated.id],guard)).rejects.toMatchObject({status:409});
    await h.pool.query("UPDATE messages SET folder='Trash' WHERE id=$1",[reply.id]);
    await expect(verifyMutedArchive(user,[first.id,reply.id],guard)).rejects.toMatchObject({status:409});
    await setMutedThread(user,first.id,{muted:false,revision:saved.revision});
    await expect(verifyMutedArchive(user,[first.id],guard)).rejects.toMatchObject({status:409});
    await expect(verifyMutedArchive(other,[first.id],guard)).rejects.toMatchObject({status:404});
  });
  it('cascades account deletion and retains setup-backup classification', async () => {
    const temporary=(await h.pool.query("INSERT INTO email_accounts(user_id,name,email_address) VALUES($1,'temp','temp@sample.example') RETURNING id",[user])).rows[0].id;
    const m=await message(temporary,'<temp@sample.example>'); await mute(m.id); await h.pool.query('DELETE FROM email_accounts WHERE id=$1',[temporary]);
    expect((await h.pool.query('SELECT id FROM muted_threads WHERE account_id=$1',[temporary])).rows).toEqual([]);
  });
});
