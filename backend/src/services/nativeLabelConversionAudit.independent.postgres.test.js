// Independent conversion review. Differential assertions compare whole conjunctions.
import { randomBytes, randomUUID } from 'crypto';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
const h = vi.hoisted(() => ({ pool: null }));
vi.mock('./db.js', () => ({
  pool: { connect: (...args) => h.pool.connect(...args) }, query: (...args) => h.pool.query(...args),
  withTransaction: async fn => { const c = await h.pool.connect(); try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } },
}));
import { runMigrations } from './migrations.js';
import { saveNativeLabelRule } from './nativeLabelRulePersistence.js';
import { convertNativeLabelRuleSearchInTransaction, parseNativeLabelRuleSearch } from './nativeLabelRuleConversion.js';
import { evaluateSearchRuleConditions } from './searchRuleSemantics.js';
import { buildSearchConditions } from './searchConditions.js';
const ADMIN = process.env.MAILFLOW_TEST_DATABASE_URL;
describe.skipIf(!ADMIN).each(['default', 'icu'])('independent exact-conversion review %s', locale => {
  const name = `mailflow_conversion_audit_${randomBytes(5).toString('hex')}`;
  let admin, user, account, label;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN }); await admin.connect();
    await admin.query(`CREATE DATABASE ${name}${locale === 'icu' ? " TEMPLATE template0 LOCALE_PROVIDER icu ICU_LOCALE 'und'" : ''}`);
    const url = new URL(ADMIN); url.pathname = `/${name}`; h.pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
    vi.spyOn(console, 'log').mockImplementation(() => {}); await runMigrations();
  }, 60000);
  afterAll(async () => { await h.pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${name}`); await admin?.end(); vi.restoreAllMocks(); });
  beforeEach(async () => {
    await h.pool.query('TRUNCATE users CASCADE');
    user = (await h.pool.query("INSERT INTO users(username) VALUES ('audit') RETURNING id")).rows[0].id;
    account = (await h.pool.query("INSERT INTO email_accounts(user_id,name,email_address) VALUES ($1,'audit','audit@test') RETURNING *", [user])).rows[0];
    label = (await h.pool.query("INSERT INTO mail_labels(account_id,name,normalized_name,full_path) VALUES ($1,'A (OR) {B}','a (or) {b}','A (OR) {B}') RETURNING *", [account.id])).rows[0];
  });
  const request = query => ({ accountId: account.id, sourceSearch: { query, accountId: account.id, expectedStorageGeneration: account.storage_generation, expectedTreeRevision: '0' }, displayedScope: { accountId: account.id, folder: 'INBOX' }, name: 'audit', actions: [{ type: 'notify' }] });
  const convert = async query => {
    const c = await h.pool.connect(); try { await c.query('BEGIN'); const body = request(query); const value = await convertNativeLabelRuleSearchInTransaction(c, { userId: user, ...body }); await c.query('COMMIT'); return value; }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  };
  it('compares complete mixed conjunctions, including asymmetric sender-name NULLs and wildcard escapes', async () => {
    const rawRows = [null, '', 'Iİıi Σσς ßSS Éé e\u0301', 'q%_\\x', 'qABx', ' parent(OR){child} '].flatMap((text, i) => [
      { from_email: text, from_name: null, subject: text, has_attachments: [null, false, true][i % 3], is_read: [true, null, false][i % 3] },
      { from_email: null, from_name: text, subject: text, has_attachments: [true, null, false][i % 3], is_read: [null, false, true][i % 3] },
    ]);
    const queries = ['from:i -subject:missing -is:unread', '-from:"q%_\\x" -has:attachment -is:read',
      'from:"q%_\\x" subject:"q%_\\x"', '-subject:σ -from:é has:attachment', '-from:missing -subject:missing -is:unread -has:attachments',
      'from:"parent(OR){child}" -subject:other'];
    for (const query of queries) {
      const converted = await convert(query), sql = buildSearchConditions(query, { firstParam: 6 });
      for (const row of rawRows) {
        const values = [row.from_email, row.from_name, row.subject, row.has_attachments, row.is_read];
        const selected = (await h.pool.query(`SELECT 1 FROM (VALUES ($1::text,$2::text,$3::text,$4::boolean,$5::boolean)) AS m(from_email,from_name,subject,has_attachments,is_read) WHERE ${sql.conditions.join(' AND ')}`, [...values, ...sql.params])).rows.length > 0;
        expect((await evaluateSearchRuleConditions(h.pool.query.bind(h.pool), converted.conditions, row)).every(Boolean), `${query}: ${JSON.stringify(row)}`).toBe(selected);
      }
    }
  });
  it('treats percent underscore and backslash as literal text, not SQL patterns', async () => {
    const conditions = (await convert('subject:"q%_\\x"')).conditions;
    const raw = subject => ({ from_email: null, from_name: null, subject, has_attachments: null, is_read: null });
    expect(await evaluateSearchRuleConditions(h.pool.query.bind(h.pool), conditions, raw('prefix q%_\\x suffix'))).toEqual([true]);
    for (const text of ['qABx', 'q%_x', 'qZZ_x', null])
      expect(await evaluateSearchRuleConditions(h.pool.query.bind(h.pool), conditions, raw(text))).toEqual([false]);
  });
  it('keeps quoted syntax literal but rejects every real group and unsupported branch intact', async () => {
    expect((await convert('label:"A (OR) {B}"')).conditions).toEqual([{ field: 'native_label', operator: 'has', value: label.id }]);
    for (const query of ['(label:"A (OR) {B}")', 'label:"A (OR) {B}" (from:x)', 'label:"A (OR) {B}" {from:x}',
      'label:"A (OR) {B}" OR from:x', 'label:"A (OR) {B}" to:x', 'label:"A (OR) {B}" after:2026/01/01',
      'label:"A (OR) {B}" free', '-(from:x)', '--from:x', 'from:(x)', 'has:attachment category:work'])
      expect(() => parseNativeLabelRuleSearch(query), query).toThrow();
  });
  it.each(['conditions', 'OR', 'foreign_scope', 'foreign_account', 'missing_negative', 'stale_generation', 'stale_tree'])('rejects handcrafted %s requests without persisting a weaker rule', async mode => {
    const body = request(`label:${label.id} -subject:private`);
    if (mode === 'conditions') body.conditions = [{ field: 'subject', operator: 'contains', value: 'x' }];
    if (mode === 'OR') body.conditionLogic = 'OR';
    if (mode === 'foreign_scope') body.displayedScope.accountId = randomUUID();
    if (mode === 'foreign_account') body.accountId = randomUUID();
    if (mode === 'missing_negative') body.sourceSearch.query = `label:${label.id} -label:${randomUUID()}`;
    if (mode === 'stale_generation') body.sourceSearch.expectedStorageGeneration = randomUUID();
    if (mode === 'stale_tree') body.sourceSearch.expectedTreeRevision = '1';
    await expect(saveNativeLabelRule(user, null, body)).rejects.toThrow();
    expect((await h.pool.query('SELECT * FROM inbox_rules')).rows).toHaveLength(0);
  });
  it('preserves approved annotation edits but rejects changed or newly injected annotations and stale microsecond revision', async () => {
    const saved = await saveNativeLabelRule(user, null, request(`label:${label.id} subject:private`));
    const edit = { name: 'edit', accountId: account.id, expectedStorageGeneration: account.storage_generation, expectedRuleRevision: saved.rule_revision, conditions: saved.conditions, actions: [{ type: 'star' }], conditionLogic: 'AND' };
    const modified = structuredClone(edit); modified.conditions[1].value = 'public';
    await expect(saveNativeLabelRule(user, saved.id, modified)).rejects.toMatchObject({ code: 'invalid_search_semantics' });
    const added = structuredClone(edit); added.conditions.push({ field: 'from', operator: 'not_contains', value: 'evil', semantics: 'search_v1' });
    await expect(saveNativeLabelRule(user, saved.id, added)).rejects.toMatchObject({ code: 'invalid_search_semantics' });
    const result = await saveNativeLabelRule(user, saved.id, edit); expect(result.conditions).toEqual(saved.conditions);
    await h.pool.query("UPDATE inbox_rules SET updated_at=updated_at+interval '1 microsecond' WHERE id=$1", [saved.id]);
    await expect(saveNativeLabelRule(user, saved.id, { ...edit, expectedRuleRevision: result.rule_revision })).rejects.toMatchObject({ code: 'rule_changed' });
  });
  it('never adopts current text for incomplete or originally null captured search evidence', async () => {
    const c = (await convert('-subject:private -is:unread -has:attachment')).conditions;
    const raw = { from_email: null, from_name: null, subject: null, is_read: null, has_attachments: null };
    expect(await evaluateSearchRuleConditions(h.pool.query.bind(h.pool), c, raw)).toEqual([true, true, true]);
    delete raw.subject;
    await expect(evaluateSearchRuleConditions(h.pool.query.bind(h.pool), c, raw)).rejects.toMatchObject({ code: 'search_evidence_unavailable' });
  });
});
