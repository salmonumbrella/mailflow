import { randomBytes, randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
const h = vi.hoisted(() => ({ pool: null }));
vi.mock('./db.js', () => ({
  pool: { connect: (...args) => h.pool.connect(...args) },
  query: (...args) => h.pool.query(...args),
  withTransaction: async fn => {
    const client = await h.pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  },
}));
import { runMigrations } from './migrations.js';
import { readMailboxIdentity, observeMailboxIdentity, writeObservedMessage } from './messageIdentity.js';
import { buildSearchConditions } from './searchConditions.js';
import { parseSearchExpression } from './searchExpression.js';
import { resolveNativeLabelSearch } from './nativeLabelSearch.js';
import { convertNativeLabelRuleSearchInTransaction } from './nativeLabelRuleConversion.js';
import { saveNativeLabelRule } from './nativeLabelRulePersistence.js';
import { captureSearchRuleFields, evaluateSearchRuleConditions } from './searchRuleSemantics.js';

const URL = process.env.MAILFLOW_TEST_DATABASE_URL;
describe.skipIf(!URL).each([
  { name: 'cluster default collation', creation: '' },
  { name: 'Unicode ICU collation', creation: " TEMPLATE template0 LOCALE_PROVIDER icu ICU_LOCALE 'und'" },
])('exact native-search rule conversion on PostgreSQL ($name)', ({ creation }) => {
  const dbName = `mailflow_rule_conversion_${randomBytes(5).toString('hex')}`;
  let admin, owner, account, label;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: URL }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}${creation}`);
    const url = new globalThis.URL(URL); url.pathname = `/${dbName}`;
    h.pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
    await runMigrations();
  }, 60_000);
  afterAll(async () => {
    await h.pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin?.end();
  });
  const tx = async fn => {
    const client = await h.pool.connect();
    try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  };
  const makeAccount = async () => (await h.pool.query("INSERT INTO email_accounts(user_id,name,email_address) VALUES ($1,'one','one@example.test') RETURNING *", [owner])).rows[0];
  const makeLabel = async (name, acct = account, parent = null) => (await h.pool.query(`INSERT INTO mail_labels(account_id,parent_id,name,normalized_name,full_path)
    VALUES ($1,$2,$3,$4,$5) RETURNING *`, [acct.id, parent?.id || null, name, name.normalize('NFC').toLowerCase(), parent ? `${parent.full_path}/${name}` : name])).rows[0];
  const request = (query, options = {}) => ({ userId: owner, sourceSearch: { query, accountId: account.id,
    expectedStorageGeneration: account.storage_generation, expectedTreeRevision: '0', ...options },
    displayedScope: { accountId: account.id, folder: 'INBOX' } });
  const convert = (query, options) => tx(client => convertNativeLabelRuleSearchInTransaction(client, request(query, options)));
  const write = async (uid, raw = {}) => {
    const context = await observeMailboxIdentity(await readMailboxIdentity(account, 'INBOX'),
      { mailbox: { path: 'INBOX', uidValidity: 10n }, capabilities: new Set(['OBJECTID']) });
    await writeObservedMessage(context, { uid, emailId: `conversion-${uid}` }, client => client.query(`
      INSERT INTO messages(account_id,uid,folder,from_email,from_name,subject,has_attachments,is_read,date)
      VALUES ($1,$2,'INBOX',$3,$4,$5,$6,$7,NOW()) RETURNING *`, [account.id, uid,
      raw.from_email ?? null, raw.from_name ?? null, raw.subject ?? null, raw.has_attachments ?? null, raw.is_read ?? null]));
    return (await h.pool.query('SELECT * FROM messages WHERE account_id=$1 AND uid=$2', [account.id, uid])).rows[0];
  };
  const tag = async row => {
    await h.pool.query('UPDATE message_entities SET metadata_version=metadata_version+1 WHERE id=$1', [row.entity_id]);
    await h.pool.query(`INSERT INTO native_label_memberships(account_id,storage_generation,entity_id,label_id)
      VALUES ($1,$2,$3,$4)`, [account.id, account.storage_generation, row.entity_id, label.id]);
  };
  beforeEach(async () => {
    await h.pool.query('TRUNCATE users CASCADE');
    owner = (await h.pool.query("INSERT INTO users(username) VALUES ('conversion-owner') RETURNING id")).rows[0].id;
    account = await makeAccount(); label = await makeLabel('Work');
  });

  it('resolves UUID, normalized full path, unique name and quoted parentheses without losing negation', async () => {
    const parent = await makeLabel('Café (Q1)'), child = await makeLabel('Child', account, parent);
    for (const query of [`label:${child.id}`, 'label:"Cafe\u0301 (Q1)/Child"', 'label:child']) {
      expect((await convert(query)).conditions).toEqual([{ field: 'native_label', operator: 'has', value: child.id }]);
    }
    expect((await convert('-label:"Café (Q1)"')).conditions[0]).toEqual({ field: 'native_label', operator: 'not_has', value: parent.id });
  });
  it('rejects missing, ambiguous, foreign, changed generation and changed tree even under negation', async () => {
    const foreign = await makeAccount(), foreignLabel = await makeLabel('Foreign', foreign);
    await expect(convert(`-label:${foreignLabel.id}`)).rejects.toMatchObject({ code: 'label_not_found' });
    await expect(convert('-label:missing')).rejects.toMatchObject({ code: 'label_not_found' });
    const root = await makeLabel('Other'); await makeLabel('Work', account, root);
    await expect(convert('-label:work')).rejects.toMatchObject({ code: 'ambiguous_label' });
    await expect(convert('label:work', { expectedStorageGeneration: randomUUID() })).rejects.toMatchObject({ code: 'storage_generation_conflict' });
    await h.pool.query('INSERT INTO mail_label_state(account_id,tree_revision) VALUES ($1,1) ON CONFLICT(account_id) DO UPDATE SET tree_revision=1', [account.id]);
    await expect(convert(`label:${label.id}`)).rejects.toMatchObject({ code: 'tree_revision_conflict' });
  });
  it('explicitly narrows unified scope and rejects mixed client predicates before querying', async () => {
    const input = request('label:work'); input.displayedScope.accountId = null;
    const result = await tx(client => convertNativeLabelRuleSearchInTransaction(client, input));
    expect(result.scopeNotice).toContain('narrows the unified search');
    await expect(tx(client => convertNativeLabelRuleSearchInTransaction(client, { ...input, clientConditions: [] }))).rejects.toMatchObject({ code: 'ambiguous_source_search' });
    await expect(convert('label:work OR from:innocent')).rejects.toMatchObject({ code: 'unsupported_rule_search' });
  });
  it('is differential with search SQL for nullable fields, literal wildcards, quotes, Unicode and negations', async () => {
    const rows = [];
    const values = [null, '', '100%_done', '100XXdone', 'a\\b', 'aXb', "x' OR true --", 'İßΣÉ', 'i\u0307ßσé', 'CAFÉ', 'cafe\u0301', ' Alice '];
    for (let i = 0; i < values.length; i++) {
      const row = await write(i + 1, { from_email: values[i], from_name: i % 2 ? values[i] : null, subject: values[i],
        has_attachments: [null, true, false][i % 3], is_read: [null, false, true][i % 3] });
      await tag(row); rows.push(row);
    }
    const queries = ['from:"100%_"', 'subject:"100%_"', 'from:"a\\b"', 'subject:"a\\b"',
      'subject:"x\' OR true --"', 'from:"İßΣÉ"', 'subject:"CAFÉ"', 'subject:"cafe\u0301"', 'from:alice',
      'has:attachment', 'has:attachments', 'is:read', 'is:unread'];
    for (const term of queries.flatMap(value => [value, `-${value}`])) for (const prefix of ['label:work ', '']) {
      const query = `${prefix}${term}`, converted = await convert(query);
      const refs = await resolveNativeLabelSearch(owner, [account.id], parseSearchExpression(query), h.pool.query.bind(h.pool));
      const compiled = buildSearchConditions(query, { firstParam: 1, nativeLabels: refs });
      const sqlIds = (await h.pool.query(`SELECT m.id FROM messages m WHERE ${compiled.conditions.join(' AND ')} ORDER BY m.id`, compiled.params)).rows.map(row => row.id);
      const convertedIds = [];
      for (const row of rows) {
        const [matches] = await evaluateSearchRuleConditions(h.pool.query.bind(h.pool), converted.conditions.filter(c => c.semantics), captureSearchRuleFields(row));
        if (matches) convertedIds.push(row.id);
      }
      expect(convertedIds.sort(), query).toEqual(sqlIds);
    }
  });
  it('never replaces captured NULL/raw fields with later source values', async () => {
    const row = await write(1, { subject: null, is_read: null, has_attachments: null });
    const raw = captureSearchRuleFields(row);
    const result = await convert('label:work -subject:changed -is:unread -has:attachment');
    await h.pool.query("UPDATE messages SET subject='changed',is_read=false,has_attachments=true WHERE id=$1", [row.id]);
    expect(await evaluateSearchRuleConditions(h.pool.query.bind(h.pool), result.conditions.filter(c => c.semantics), raw)).toEqual([true, true, true]);
  });
  it('preserves unavailable native identity under positive and negative SQL', async () => {
    const tagged = await write(1), empty = await write(2); await tag(tagged);
    const unknown = (await h.pool.query("INSERT INTO messages(account_id,uid,folder,subject) VALUES ($1,3,'INBOX','unknown') RETURNING *", [account.id])).rows[0];
    for (const [query, expected] of [['label:work', [tagged.id]], ['-label:work', [empty.id]]]) {
      const converted = await convert(query);
      const refs = await resolveNativeLabelSearch(owner, [account.id], parseSearchExpression(query), h.pool.query.bind(h.pool));
      const sql = buildSearchConditions(query, { firstParam: 1, nativeLabels: refs });
      const found = (await h.pool.query(`SELECT m.id FROM messages m WHERE ${sql.conditions[0]}`, sql.params)).rows.map(row => row.id);
      expect(found).toEqual(expected); expect(found).not.toContain(unknown.id);
      expect(converted.conditions[0].operator).toBe(query.startsWith('-') ? 'not_has' : 'has');
    }
  });
  it('holds definition resolution through persistence; a waiting rename forces the next explicit review', async () => {
    const saver = await h.pool.connect(), writer = await h.pool.connect();
    try {
      await saver.query('BEGIN'); await writer.query('BEGIN');
      const converted = await convertNativeLabelRuleSearchInTransaction(saver, request('label:work'));
      let acquired = false;
      const waiting = writer.query('SELECT id FROM email_accounts WHERE id=$1 FOR UPDATE', [account.id]).then(() => { acquired = true; });
      // A real PostgreSQL wait-state, not just a timer-based lock assertion.
      let waitingOnLock = false;
      for (let i = 0; i < 100 && !waitingOnLock; i++) {
        const state = await h.pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [writer.processID]);
        waitingOnLock = state.rows[0]?.wait_event_type === 'Lock';
        if (!waitingOnLock) await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(waitingOnLock).toBe(true); expect(acquired).toBe(false);
      await saver.query(`INSERT INTO inbox_rules(user_id,account_id,name,conditions,actions,storage_generation)
        VALUES ($1,$2,'saved',$3,$4,$5)`, [owner, account.id, JSON.stringify(converted.conditions), JSON.stringify([{ type: 'notify' }]), account.storage_generation]);
      await saver.query('COMMIT'); await waiting;
      await writer.query("UPDATE mail_labels SET name='Renamed',normalized_name='renamed',full_path='Renamed' WHERE id=$1", [label.id]);
      await writer.query('INSERT INTO mail_label_state(account_id,tree_revision) VALUES ($1,1) ON CONFLICT(account_id) DO UPDATE SET tree_revision=1', [account.id]);
      await writer.query('COMMIT');
      expect((await h.pool.query("SELECT conditions FROM inbox_rules WHERE name='saved'")).rows[0].conditions[0].value).toBe(label.id);
      await expect(convert('label:work')).rejects.toMatchObject({ code: 'tree_revision_conflict' });
    } finally { await saver.query('ROLLBACK'); await writer.query('ROLLBACK'); saver.release(); writer.release(); }
  });
  it('persists server canonical UUID and annotations, rejects forged predicates, and conflicts concurrent edits', async () => {
    const body = { ...request('label:work -subject:"100%_"'), accountId: account.id, name: 'canonical', actions: [{ type: 'notify' }], conditionLogic: 'AND' };
    delete body.userId;
    await expect(saveNativeLabelRule(owner, null, { ...body, conditions: [{ field: 'from', operator: 'contains', value: 'weaker' }] }))
      .rejects.toMatchObject({ code: 'ambiguous_source_search' });
    await expect(saveNativeLabelRule(owner, null, { accountId: account.id, name: 'forged', expectedStorageGeneration: account.storage_generation,
      conditions: [{ field: 'subject', operator: 'contains', value: 'x', semantics: 'search_v1' }], actions: [{ type: 'notify' }] }))
      .rejects.toMatchObject({ code: 'invalid_search_semantics' });
    const saved = await saveNativeLabelRule(owner, null, body);
    expect(saved.conditions).toEqual([{ field: 'native_label', operator: 'has', value: label.id },
      { field: 'subject', operator: 'not_contains', value: '100%_', semantics: 'search_v1' }]);
    const outcomes = await Promise.allSettled(['one', 'two'].map(name => saveNativeLabelRule(owner, saved.id, { ...body, name, expectedRuleRevision: saved.rule_revision })));
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(result => result.status === 'rejected').reason.code).toBe('rule_changed');
    expect((await h.pool.query('SELECT count(*)::int AS count FROM inbox_rules')).rows[0].count).toBe(1);
  });
  it('generation replacement while conversion waits fails without adopting a new snapshot', async () => {
    const writer = await h.pool.connect();
    try {
      await writer.query('BEGIN'); await writer.query('SELECT id FROM email_accounts WHERE id=$1 FOR UPDATE', [account.id]);
      await writer.query('UPDATE email_accounts SET storage_generation=$2 WHERE id=$1', [account.id, randomUUID()]);
      const saving = convert('label:work');
      await writer.query('COMMIT');
      await expect(saving).rejects.toMatchObject({ code: 'storage_generation_conflict' });
    } finally { await writer.query('ROLLBACK'); writer.release(); }
  });
  it('does not use preview name resolution after a concurrent definition edit acquired the account lock first', async () => {
    const writer = await h.pool.connect();
    try {
      await writer.query('BEGIN'); await writer.query('SELECT id FROM email_accounts WHERE id=$1 FOR UPDATE', [account.id]);
      await writer.query('INSERT INTO mail_label_state(account_id,tree_revision) VALUES ($1,1) ON CONFLICT(account_id) DO UPDATE SET tree_revision=1', [account.id]);
      const saving = convert('label:work');
      await writer.query('COMMIT');
      await expect(saving).rejects.toMatchObject({ code: 'tree_revision_conflict' });
    } finally { await writer.query('ROLLBACK'); writer.release(); }
  });
});
