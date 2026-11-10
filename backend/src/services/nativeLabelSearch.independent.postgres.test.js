import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { buildSearchConditions } from './searchConditions.js';
import { parseSearchExpression } from './searchExpression.js';
import { resolveNativeLabelSearch } from './nativeLabelSearch.js';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const account = id(1), generation = id(2), label = id(3), owner = id(4);
const not = a => a === null ? null : !a;
const and = (a, b) => a === false || b === false ? false : a === null || b === null ? null : true;
const or = (a, b) => a === true || b === true ? true : a === null || b === null ? null : false;
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('independent native-label Boolean and resolution contracts', () => {
  let db;
  beforeAll(async () => {
    db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL }); await db.connect();
    await db.query(`CREATE TEMP TABLE email_accounts(id uuid,user_id uuid,storage_generation uuid,enabled boolean);
      CREATE TEMP TABLE mail_label_state(account_id uuid,tree_revision bigint);
      CREATE TEMP TABLE mail_labels(id uuid,account_id uuid,name text,full_path text);
      CREATE TEMP TABLE messages(id uuid,account_id uuid,storage_generation uuid,entity_id uuid,folder text,uid bigint,uid_validity bigint,is_deleted boolean,subject text,rfc822_size_bytes bigint);
      CREATE TEMP TABLE entity_locations(account_id uuid,storage_generation uuid,entity_id uuid,folder_path text,uid bigint,uid_validity bigint,status text);
      CREATE TEMP TABLE mailbox_identity_epochs(account_id uuid,storage_generation uuid,folder_path text,uid_validity bigint);
      CREATE TEMP TABLE message_entities(id uuid,account_id uuid,storage_generation uuid,canonical_entity_id uuid);
      CREATE TEMP TABLE native_label_memberships(account_id uuid,storage_generation uuid,entity_id uuid,label_id uuid);
      INSERT INTO email_accounts VALUES ('${account}','${owner}','${generation}',true);
      INSERT INTO mail_label_state VALUES ('${account}',7);
      INSERT INTO mail_labels VALUES ('${label}','${account}','Résumé','Parent/Résumé');
      INSERT INTO mailbox_identity_epochs VALUES ('${account}','${generation}','INBOX',10);`);
    for (let i = 0; i < 9; i++) {
      const entity = id(200 + i);
      await db.query(`INSERT INTO messages VALUES ($1,$2,$3,$4,'INBOX',$5,10,false,NULL,$6)`, [id(100 + i), account, generation, i < 6 ? entity : null, i + 1, [0, 2000, null][i % 3]]);
      if (i < 6) {
        await db.query('INSERT INTO message_entities VALUES ($1,$2,$3,NULL)', [entity, account, generation]);
        await db.query("INSERT INTO entity_locations VALUES ($1,$2,$3,'INBOX',$4,10,'present')", [account, generation, entity, i + 1]);
        if (i < 3) await db.query('INSERT INTO native_label_memberships VALUES ($1,$2,$3,$4)', [account, generation, entity, label]);
      }
    }
  });
  afterAll(async () => { await db?.end(); });
  const resolve = raw => resolveNativeLabelSearch(owner, [account], parseSearchExpression(raw), (...args) => db.query(...args));
  const results = async raw => {
    const built = buildSearchConditions(raw, { firstParam: 1, nativeLabels: await resolve(raw) });
    return (await db.query(`SELECT ${built.conditions[0]} AS matched FROM messages m ORDER BY m.uid`, built.params)).rows.map(row => row.matched);
  };
  it('preserves all nine label/size combinations through nested Boolean negation', async () => {
    for (const [raw, evaluate] of [
      ['label:Résumé', a => a], ['-label:Résumé', a => not(a)],
      ['label:Résumé OR larger:1000', or], ['label:Résumé AND larger:1000', and],
      ['-(label:Résumé OR larger:1000)', (a, b) => not(or(a, b))],
      ['-(label:Résumé AND larger:1000)', (a, b) => not(and(a, b))],
      ['-(-label:Résumé OR -larger:1000)', (a, b) => not(or(not(a), not(b)))],
      ['-(label:Résumé AND subject:absent)', a => not(and(a, false))],
      ['label:Résumé OR -subject:absent', a => or(a, true)],
    ]) expect(await results(raw), raw).toEqual([true, false, null].flatMap(a => [false, true, null].map(b => evaluate(a, b))));
  });
  it('resolves NFC, case-insensitive exact paths and UUIDs without suffix matching', async () => {
    for (const raw of ['label:résumé', 'label:"Parent/Re\u0301sume\u0301"', `label:${label.toUpperCase()}`])
      expect((await resolve(raw)).resolvedReferences[0]).toMatchObject({ labelId: label, accountId: account, storageGeneration: generation, treeRevision: '7' });
    await expect(resolve('label:"arent/Résumé"')).rejects.toMatchObject({ code: 'label_not_found' });
  });
  it('rejects missing references even when negative or true OR branches would hide them', async () => {
    for (const raw of ['-label:missing', 'label:missing OR -subject:absent', '-(label:missing AND subject:absent)'])
      await expect(resolve(raw)).rejects.toMatchObject({ code: 'label_not_found' });
  });
  it('never makes ambiguity depend on first row or discloses foreign candidates', async () => {
    await db.query('INSERT INTO mail_labels VALUES ($1,$2,$3,$4),($5,$6,$3,$7)', [id(500), account, 'Résumé', 'Other/Résumé', id(501), id(999), 'Foreign/Résumé']);
    try { await resolve('label:Résumé'); throw new Error('Expected ambiguity'); }
    catch (error) {
      expect(error.code).toBe('ambiguous_label');
      expect(error.candidates.map(candidate => candidate.path).sort()).toEqual(['Other/Résumé', 'Parent/Résumé']);
      expect(error.candidates.every(candidate => candidate.accountId === account)).toBe(true);
    }
    expect((await resolve('label:"Parent/Résumé"')).resolvedReferences[0].labelId).toBe(label);
  });
});
