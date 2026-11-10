import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ pool: null, userId: null }));
vi.mock('../services/db.js', () => ({
  pool: { connect: (...args) => h.pool.connect(...args) }, query: (...args) => h.pool.query(...args),
  withTransaction: async fn => { const tx = await h.pool.connect(); try { await tx.query('BEGIN'); const result = await fn(tx); await tx.query('COMMIT'); return result; } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); } },
}));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: h.userId }; next(); } }));
import express from 'express';
import routes from './rules.js';
import { runMigrations } from '../services/migrations.js';
import { createDefinition, deleteDefinition, previewDeletion, updateDefinition } from '../services/nativeLabelDefinitions.js';
const URL = process.env.MAILFLOW_TEST_DATABASE_URL;
describe.skipIf(!URL)('native label rule persistence on PostgreSQL', () => {
  let admin, server, base, account, label, foreign;
  const db = `mailflow_native_rules_${randomBytes(4).toString('hex')}`;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: URL }); await admin.connect(); await admin.query(`CREATE DATABASE ${db}`);
    const url = new globalThis.URL(URL); url.pathname = `/${db}`; h.pool = new pg.Pool({ connectionString: url.toString() });
    vi.spyOn(console, 'log').mockImplementation(() => {}); await runMigrations();
    h.userId = (await h.pool.query("INSERT INTO users(username) VALUES('native-rule-owner') RETURNING id")).rows[0].id;
    const app = express(); app.use(express.json()); app.set('imapManager', { broadcast: vi.fn() }); app.use('/rules', routes);
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${server.address().port}/rules`;
  }, 60000);
  afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); await h.pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${db}`); await admin?.end(); vi.restoreAllMocks(); });
  beforeEach(async () => {
    await h.pool.query('DELETE FROM inbox_rules'); await h.pool.query('DELETE FROM email_accounts');
    const acct = async email => (await h.pool.query("INSERT INTO email_accounts(user_id,name,email_address,imap_host) VALUES($1,'Rule',$2,'imap.example.test') RETURNING *", [h.userId,email])).rows[0];
    account = await acct('owner@example.test'); const other = await acct('other@example.test');
    label = (await createDefinition(h.userId, { accountId: account.id, mutationId: randomUUID(), name: 'Invoices' })).result.label;
    foreign = (await createDefinition(h.userId, { accountId: other.id, mutationId: randomUUID(), name: 'Private' })).result.label;
  });
  const body = extra => ({ name: 'Label invoices', accountId: account.id, expectedStorageGeneration: account.storage_generation,
    conditions: [{ field: 'subject', operator: 'contains', value: 'invoice' }], actions: [{ type: 'apply_native_label', value: label.id }], ...extra });
  const call = async (method, path = '', data) => {
    if (method === 'PUT' && data.expectedRuleRevision === undefined) data = {...data, expectedRuleRevision:(await h.pool.query('SELECT updated_at::text AS revision FROM inbox_rules WHERE id=$1',[path.slice(1)])).rows[0]?.revision};
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }); return { status: res.status, body: await res.json() }; };
  const remove = async id => { const preview = await previewDeletion(h.userId, id, { accountId: account.id }); return deleteDefinition(h.userId,id,{ accountId: account.id,mutationId:randomUUID(),expectedTreeRevision:preview.treeRevision,confirmSubtree:true }); };
  it('saves account and generation with deduplicated explicit UUID actions and exact revision', async () => {
    const action = { type: 'apply_native_label', value: label.id };
    const result = await call('POST','',body({ actions: [action, action] }));
    expect(result).toMatchObject({ status: 201, body: { account_id: account.id, storage_generation: account.storage_generation, actions: [action], rule_revision: expect.any(String) } });
  });
  it.each(['create', 'toggle'])('ordinary %s responses support a native edit without a reload', async operation => {
    const ordinary = body({ actions: [{ type: 'star' }] });
    let saved = await call('POST', '', ordinary);
    expect(saved.status).toBe(201);
    if (operation === 'toggle') {
      saved = await call('PUT', `/${saved.body.id}`, { ...ordinary, enabled: false });
      expect(saved.status).toBe(200);
    }
    const revision = (await h.pool.query('SELECT updated_at::text AS revision FROM inbox_rules WHERE id=$1', [saved.body.id])).rows[0].revision;
    // Bypass the legacy test helper: no hidden GET may supply the missing DTO field.
    const response = await fetch(`${base}/${saved.body.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body({ expectedRuleRevision: saved.body.rule_revision })) });
    expect(response.status).toBe(200);
    expect(saved.body.rule_revision).toBe(revision);
    const converted = await response.json();
    expect(converted.actions).toEqual(body().actions);
    expect(converted.rule_revision).toEqual(expect.any(String));
    expect(converted.rule_revision).not.toBe(revision);
  });
  it('rejects global, stale, foreign, missing and conflicting native actions without creating rules', async () => {
    for (const extra of [{ accountId: null }, { expectedStorageGeneration: randomUUID() }, { expectedStorageGeneration: undefined },
      { actions: [{ type: 'apply_native_label', value: foreign.id }] }, { actions: [{ type: 'apply_native_label', value: randomUUID() }] },
      { actions: [{ type: 'apply_native_label', value: label.id }, { type: 'remove_native_label', value: label.id }] }]) {
      expect((await call('POST','',body(extra))).status).toBeGreaterThanOrEqual(400);
    }
    expect((await h.pool.query('SELECT * FROM inbox_rules')).rows).toHaveLength(0);
  });
  it('rejects malformed or unsupported native shapes before normalization', async () => {
    for (const extra of [{ actions: [null, ...body().actions] }, { actions: [...body().actions, { type: 'future_action' }] },
      { conditions: [{ field:'has_attachment',operator:'not_equals',value:false }] }, { conditions: [{ field:'native_label',operator:'contains',value:label.id }] }]) {
      expect((await call('POST','',body(extra))).status).toBe(400);
    }
  });
  it('resolves live paths after rename while preserving UUIDs and blocks referenced subtree deletion', async () => {
    const child = (await createDefinition(h.userId,{ accountId:account.id,mutationId:randomUUID(),name:'Child',parentId:label.id })).result.label;
    const saved = await call('POST','',body({ actions:[{type:'remove_native_label',value:child.id}] }));
    await updateDefinition(h.userId,label.id,{accountId:account.id,mutationId:randomUUID(),expectedRevision:label.revision,name:'Renamed'});
    expect((await call('GET')).body[0].nativeLabelReferences).toEqual([{id:child.id,path:'Renamed/Child',missing:false}]);
    const preview = await previewDeletion(h.userId,label.id,{accountId:account.id});
    expect(preview).toMatchObject({blockedByRules:true,affectedRules:[{id:saved.body.id,name:'Label invoices',enabled:true}]});
    await expect(remove(label.id)).rejects.toMatchObject({code:'label_referenced_by_rule'});
  });
  it('retains disabled broken references visibly and rejects re-enable and historical run', async () => {
    const saved = await call('POST','',body());
    expect((await call('PUT',`/${saved.body.id}`,body({enabled:false}))).status).toBe(200);
    await remove(label.id);
    expect((await call('GET')).body[0].nativeLabelReferences).toEqual([{id:label.id,path:null,missing:true}]);
    expect((await call('PUT',`/${saved.body.id}`,body({enabled:false,name:'Repair later'}))).status).toBe(200);
    expect(await call('PUT',`/${saved.body.id}`,body())).toMatchObject({status:409,body:{code:'missing_label_reference'}});
    expect((await call('POST',`/${saved.body.id}/run`,{accountIds:[account.id]})).status).toBe(400);
    expect((await h.pool.query('SELECT enabled,actions FROM inbox_rules WHERE id=$1',[saved.body.id])).rows[0]).toMatchObject({enabled:false,actions:body().actions});
  });
  it('rejects execution of malformed restored enabled references', async () => {
    const saved = await call('POST','',body());
    await h.pool.query('UPDATE inbox_rules SET enabled=false WHERE id=$1',[saved.body.id]); await remove(label.id);
    await h.pool.query('UPDATE inbox_rules SET enabled=true WHERE id=$1',[saved.body.id]);
    expect(await call('POST',`/${saved.body.id}/run`,{accountIds:[account.id]})).toMatchObject({status:409,body:{code:'missing_label_reference'}});
  });
  it('does not adopt a replacement generation for same-account rule edits', async () => {
    const saved = await call('POST','',body({enabled:false})); const newer=randomUUID();
    await h.pool.query('UPDATE email_accounts SET storage_generation=$2 WHERE id=$1',[account.id,newer]);
    expect(await call('PUT',`/${saved.body.id}`,body({expectedStorageGeneration:newer}))).toMatchObject({status:409,body:{code:'storage_generation_conflict'}});
    expect((await h.pool.query('SELECT storage_generation,enabled FROM inbox_rules WHERE id=$1',[saved.body.id])).rows[0]).toMatchObject({storage_generation:account.storage_generation,enabled:false});
  });
  it.each(['has','not_has'])('persists condition-only %s UUID references and blocks deletion until disabled',async operator=>{
    const input=body({conditions:[{field:'native_label',operator,value:label.id}],actions:[{type:'star'}]});
    const saved=await call('POST','',input);expect(saved.status).toBe(201);
    const preview=await previewDeletion(h.userId,label.id,{accountId:account.id});expect(preview.blockedByRules).toBe(true);
    await expect(remove(label.id)).rejects.toMatchObject({code:'label_referenced_by_rule'});
    expect((await call('PUT',`/${saved.body.id}`,{...input,enabled:false})).status).toBe(200);
    await remove(label.id);
    expect((await call('GET')).body[0].nativeLabelReferences).toEqual([{id:label.id,path:null,missing:true}]);
    expect(await call('PUT',`/${saved.body.id}`,input)).toMatchObject({status:409,body:{code:'missing_label_reference'}});
  });
  it('uses exact CAS revisions for edits and advances revision on reorder',async()=>{
    const saved=await call('POST','',body());
    const changed=await call('PUT',`/${saved.body.id}`,body({name:'Changed',expectedRuleRevision:saved.body.rule_revision}));expect(changed.status).toBe(200);
    expect(await call('PUT',`/${saved.body.id}`,body({name:'Lost update',expectedRuleRevision:saved.body.rule_revision}))).toMatchObject({status:409,body:{code:'rule_changed'}});
    const reordered=await call('PATCH','/reorder',{ids:[saved.body.id]});expect(reordered.status).toBe(200);
    expect((await call('GET')).body[0].rule_revision).not.toBe(changed.body.rule_revision);
  });
  it('rejects a historical request naming an earlier saved revision',async()=>{
    const saved=await call('POST','',body({conditions:[{field:'native_label',operator:'not_has',value:label.id}],actions:[{type:'star'}]}));
    await h.pool.query("UPDATE inbox_rules SET updated_at=updated_at+INTERVAL '1 microsecond' WHERE id=$1",[saved.body.id]);
    expect(await call('POST',`/${saved.body.id}/run`,{accountIds:[account.id],expectedRuleRevision:saved.body.rule_revision})).toMatchObject({status:409,body:{code:'rule_changed'}});
  });

});
