import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getSignatureLibrary, saveSignatureLibrary, syncLegacyAccountSignature, syncLegacyAliasSignature, validateSignatureLibrary } from './signatureLibrary.js';
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', U = '33333333-3333-4333-8333-333333333333', AL = '44444444-4444-4444-8444-444444444444';
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('signature library on PostgreSQL', () => {
  let db;
  const tx = async fn => { await db.query('BEGIN'); try { const value = await fn(db); await db.query('COMMIT'); return value; } catch (e) { await db.query('ROLLBACK'); throw e; } };
  const get = (account = A, user = U) => getSignatureLibrary(user, account, tx);
  const save = data => saveSignatureLibrary(U, A, data, tx);
  beforeAll(async () => {
    db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL }); await db.connect();
    await db.query('CREATE TEMP TABLE email_accounts(id uuid PRIMARY KEY,user_id uuid,signature text,signature_enabled boolean DEFAULT true); CREATE TEMP TABLE account_aliases(id uuid PRIMARY KEY,account_id uuid REFERENCES email_accounts(id),signature text)');
    await db.query(readFileSync(new URL('../../migrations/0080_signature_library.sql', import.meta.url), 'utf8').replaceAll('CREATE TABLE ', 'CREATE TEMP TABLE '));
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => {
    await db.query('TRUNCATE email_accounts,account_aliases,mail_signature_state,mail_signatures,mail_signature_defaults');
    await db.query("INSERT INTO email_accounts VALUES($1,$3,'<b>Original</b>',true),($2,$2,'Other user',true)", [A,B,U]);
    await db.query('INSERT INTO account_aliases VALUES($1,$2,NULL)', [AL,A]);
  });
  it('imports legacy account/alias inheritance once with stable identities', async () => {
    const first = await get(), second = await get(); expect(second).toEqual(first);
    expect(first.signatures).toHaveLength(1); expect(first.defaults).toHaveLength(2);
    expect(new Set(first.defaults.map(d => d.newSignatureId))).toEqual(new Set([first.signatures[0].id]));
  });
  it('preserves disabled legacy records and explicit empty alias', async () => {
    await db.query('UPDATE email_accounts SET signature_enabled=false WHERE id=$1', [A]);
    await db.query("UPDATE account_aliases SET signature='' WHERE id=$1", [AL]);
    const library = await get(); expect(library.signatures).toHaveLength(1);
    expect(library.defaults.every(d => d.newSignatureId === null && d.replySignatureId === null)).toBe(true);
  });
  it('creates/renames/deletes and mirrors defaults without reviving deleted legacy content', async () => {
    const first = await get(), id = randomUUID();
    const added = await save({ ...first, signatures: [...first.signatures, { id, name: 'Business', content: '<b>Team</b><script>bad()</script>', isPlainText: false }],
      defaults: first.defaults.map(d => ({ ...d, newSignatureId: id, replySignatureId: first.signatures[0].id })) });
    expect(added.signatures[1].content).toBe('<b>Team</b>');
    expect((await db.query('SELECT signature FROM email_accounts WHERE id=$1',[A])).rows[0].signature).toBe('<b>Team</b>');
    const empty = await save({ ...added, signatures: [], defaults: added.defaults.map(d => ({ ...d,newSignatureId:null,replySignatureId:null })) });
    expect((await get()).signatures).toEqual([]); expect(empty.defaults.every(d=>d.newSignatureId===null)).toBe(true);
    expect((await db.query('SELECT signature FROM account_aliases WHERE id=$1',[AL])).rows[0].signature).toBe('');
    await tx(async c=>{ await c.query('UPDATE email_accounts SET signature_enabled=true WHERE id=$1',[A]); await syncLegacyAccountSignature(c,A,{enabledChanged:true}); });
    expect((await get()).signatures).toEqual([]);
  });
  it('stores literal angle brackets exactly and mirrors escaped HTML', async () => {
    const first=await get(); first.signatures[0] = { ...first.signatures[0],content:'Me <me@example.com>\nA & B <b>literal</b>',isPlainText:true };
    const saved=await save(first); expect(saved.signatures[0].content).toBe(first.signatures[0].content);
    expect((await db.query('SELECT signature FROM email_accounts WHERE id=$1',[A])).rows[0].signature).toContain('&lt;me@example.com&gt;');
  });
  it('rejects foreign accounts, signatures, aliases and stale revision without mutation',async()=>{
    const first=await get(); await expect(get(B)).rejects.toMatchObject({status:404});
    const foreign=await get(B,B);
    await expect(save({...first,signatures:foreign.signatures,defaults:first.defaults.map(d=>({...d,newSignatureId:foreign.signatures[0].id,replySignatureId:null}))})).rejects.toMatchObject({status:400});
    await expect(save({...first,defaults:[{senderKey:B,newSignatureId:null,replySignatureId:null}]})).rejects.toMatchObject({status:400});
    await save(first); await expect(save(first)).rejects.toMatchObject({status:409});
    expect((await get(B,B)).signatures).toEqual(foreign.signatures);
  });
  it('legacy account edits update the selected record atomically; same-value updates keep reply selection', async()=>{
    const first=await get(), other={id:randomUUID(),name:'Reply',content:'Reply',isPlainText:false};
    const saved=await save({...first,signatures:[...first.signatures,other],defaults:first.defaults.map(d=>({...d,replySignatureId:other.id}))});
    await tx(async c=>{await syncLegacyAccountSignature(c,A,{signatureChanged:true,enabledChanged:true});});
    expect((await get()).defaults[0].replySignatureId).toBe(other.id);
    await tx(async c=>{await c.query("UPDATE email_accounts SET signature='<i>Edited</i>' WHERE id=$1",[A]);await syncLegacyAccountSignature(c,A,{signatureChanged:true});});
    const edited=await get(); const main = edited.defaults.find(d => d.senderKey === 'main');
    expect(edited.signatures.find(s=>s.id===main.newSignatureId).content).toBe('<i>Edited</i>');
    expect(edited.signatures.find(s=>s.id===saved.signatures[0].id).content).toBe('<b>Original</b>');
    expect(edited.defaults.find(d => d.senderKey === AL).newSignatureId).toBe(saved.signatures[0].id);
    await expect(tx(async c=>{await c.query("UPDATE email_accounts SET signature='Rollback' WHERE id=$1",[A]);await syncLegacyAccountSignature(c,A,{signatureChanged:true});throw Error('stop');})).rejects.toThrow('stop');
    expect((await get()).signatures).toEqual(edited.signatures);
  });
  it('legacy alias edits and newly created aliases synchronize without changing another account',async()=>{
    await get(); await tx(async c=>{await c.query("UPDATE account_aliases SET signature='<p>Alias</p>' WHERE id=$1",[AL]);await syncLegacyAliasSignature(c,A,AL);});
    const edited=await get(); expect(edited.signatures).toHaveLength(2); // alias override does not change the inherited main record
    const next=randomUUID(); await tx(async c=>{await c.query('INSERT INTO account_aliases VALUES($1,$2,NULL)',[next,A]);await syncLegacyAliasSignature(c,A,next);});
    expect((await get()).defaults).toHaveLength(3);
  });
  it('legacy main clears and later edits follow null-inheriting aliases without reviving their old signature', async () => {
    await get();
    await tx(async c => { await c.query("UPDATE email_accounts SET signature='' WHERE id=$1", [A]); await syncLegacyAccountSignature(c,A,{signatureChanged:true}); });
    const cleared = await get(); expect(cleared.defaults.every(d => d.newSignatureId === null && d.replySignatureId === null)).toBe(true);
    await tx(async c => { await c.query("UPDATE email_accounts SET signature='Replacement' WHERE id=$1", [A]); await syncLegacyAccountSignature(c,A,{signatureChanged:true}); });
    const replaced = await get(); expect(new Set(replaced.defaults.map(d => d.newSignatureId)).size).toBe(1);
    expect(replaced.signatures.find(s => s.id === replaced.defaults[0].newSignatureId).content).toBe('Replacement');
  });
  it('enforces same-account references and deferred restore ordering in PostgreSQL',async()=>{
    const a=await get(), b=await get(B,B);
    await expect(tx(c=>c.query('UPDATE mail_signature_defaults SET new_signature_id=$2 WHERE account_id=$1',[A,b.signatures[0].id]))).rejects.toMatchObject({code:'23503'});
    await expect(tx(c=>c.query('UPDATE mail_signature_defaults SET alias_id=$2::uuid,sender_key=$2::text WHERE account_id=$1 AND sender_key=\'main\'',[A,B]))).rejects.toMatchObject({code:'23503'});
    expect((await get()).signatures).toEqual(a.signatures);
  });
});
describe('signature validation',()=>{
  const record={id:A,name:'Main',content:'<script>bad</script><b onclick="bad()">Safe</b>',isPlainText:false};
  it('sanitizes rich content and rejects duplicate names, invalid formats and missing defaults',()=>{
    expect(validateSignatureLibrary({revision:'1',signatures:[record],defaults:[]}).signatures[0].content).toBe('<b>Safe</b>');
    for(const signatures of [[record,{...record,id:B,name:' main '}],[{...record,isPlainText:'true'}],[{...record,name:'\n'}]]) expect(()=>validateSignatureLibrary({revision:'1',signatures,defaults:[]})).toThrow();
    expect(()=>validateSignatureLibrary({revision:'1',signatures:[],defaults:[{senderKey:'main',newSignatureId:A,replySignatureId:null}]})).toThrow();
  });
});
