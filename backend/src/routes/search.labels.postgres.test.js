import { randomBytes, randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import express from 'express';
const h = vi.hoisted(() => ({ pool: null, owner: null, afterResolve: null }));
vi.mock('../services/db.js', () => ({
  pool: { connect: (...args) => h.pool.connect(...args) },
  query: (...args) => h.pool.query(...args),
  withTransaction: async fn => {
    const client = await h.pool.connect();
    const execute = async (sql, params) => {
      const result = await client.query(sql, params);
      if (h.afterResolve && sql.includes('ORDER BY a.id LIMIT 201')) {
        const hook = h.afterResolve; h.afterResolve = null; await hook();
      }
      return result;
    };
    try { await client.query('BEGIN'); const result = await fn({ query: execute }); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  },
}));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => {
  req.session = { userId: h.owner };
  if (req.get('x-test-token')) req.apiToken = { id: 'test-token' };
  next();
} }));
import routes from './search.js';
import { runMigrations } from '../services/migrations.js';
import { readMailboxIdentity, observeMailboxIdentity, writeObservedMessage } from '../services/messageIdentity.js';
import { updateDefinition, deleteDefinition } from '../services/nativeLabelDefinitions.js';
import { buildSearchConditions } from '../services/searchConditions.js';
import { parseSearchExpression } from '../services/searchExpression.js';
import { resolveNativeLabelSearch } from '../services/nativeLabelSearch.js';
import { listNativeLabelMessages } from '../services/nativeLabelReadModel.js';

const URL = process.env.MAILFLOW_TEST_DATABASE_URL;
describe.skipIf(!URL)('native label search on PostgreSQL', () => {
  const dbName = `mailflow_label_search_${randomBytes(5).toString('hex')}`;
  let admin, account, second, foreign, label, child, server, base;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: URL }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new globalThis.URL(URL); url.pathname = `/${dbName}`;
    h.pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
    await runMigrations();
    const app = express(); app.use(routes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  }, 60_000);
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await h.pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin?.end();
  });
  const makeAccount = async (user = h.owner, name = 'one') => (await h.pool.query(
    'INSERT INTO email_accounts(user_id,name,email_address) VALUES ($1,$2,$3) RETURNING *', [user, name, `${name}@example.test`])).rows[0];
  const makeLabel = async (name, acct = account, parent = null) => (await h.pool.query(`INSERT INTO mail_labels(account_id,parent_id,name,normalized_name,full_path)
    VALUES ($1,$2,$3,$4,$5) RETURNING *`, [acct.id, parent?.id || null, name, name.normalize('NFC').toLowerCase(), parent ? `${parent.full_path}/${name}` : name])).rows[0];
  const context = async (acct = account, folder = 'INBOX', epoch = '10') => observeMailboxIdentity(await readMailboxIdentity(acct, folder),
    { mailbox: { path: folder, uidValidity: BigInt(epoch) }, capabilities: new Set(['OBJECTID']) });
  const write = async (uid, { acct = account, folder = 'INBOX', providerId, size = 100, subject = 'hello' } = {}) => {
    await writeObservedMessage(await context(acct, folder), { uid, ...(providerId ? { emailId: providerId } : {}) }, client => client.query(`
      INSERT INTO messages(account_id,uid,folder,subject,date,rfc822_size_bytes) VALUES ($1,$2,$3,$4,NOW(),$5)
      ON CONFLICT(account_id,uid,folder) DO UPDATE SET subject=EXCLUDED.subject RETURNING *`, [acct.id, uid, folder, subject, size]));
    return (await h.pool.query('SELECT * FROM messages WHERE account_id=$1 AND uid=$2 AND folder=$3', [acct.id, uid, folder])).rows[0];
  };
  const tag = async (row, id = label.id) => {
    await h.pool.query('UPDATE message_entities SET metadata_version=metadata_version+1 WHERE id=$1', [row.entity_id]);
    await h.pool.query(`INSERT INTO native_label_memberships(account_id,storage_generation,entity_id,label_id)
      VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [row.account_id, row.storage_generation, row.entity_id, id]);
  };
  const search = async (q, scope = {}, status = 200, token = false) => {
    const response = await fetch(`${base}/?${new URLSearchParams({ q, ...scope })}`, { headers: token ? { 'x-test-token': 'yes' } : {} });
    const data = await response.json();
    expect(response.status, JSON.stringify(data)).toBe(status);
    return { ...data, ids: data.messages?.map(row => row.id).sort() };
  };
  beforeEach(async () => {
    h.afterResolve = null;
    await h.pool.query('TRUNCATE users CASCADE');
    h.owner = (await h.pool.query("INSERT INTO users(username) VALUES ('search-owner') RETURNING id")).rows[0].id;
    const otherOwner = (await h.pool.query("INSERT INTO users(username) VALUES ('foreign-owner') RETURNING id")).rows[0].id;
    account = await makeAccount(); second = await makeAccount(h.owner, 'two'); foreign = await makeAccount(otherOwner, 'foreign');
    label = await makeLabel('Work'); child = await makeLabel('Child', account, label);
  });

  it('resolves owned UUID, exact full path and unique short name; matches direct membership only', async () => {
    const parent = await write(1), nested = await write(2); await tag(parent); await tag(nested, child.id);
    expect((await search(`label:${label.id}`)).ids).toEqual([parent.id]);
    expect((await search('label:work')).ids).toEqual([parent.id]);
    expect((await search('label:"Work/Child"')).ids).toEqual([nested.id]);
    expect((await search('label:child')).ids).toEqual([nested.id]);
    expect((await search('label:"Other/Child"', {}, 400)).code).toBe('label_not_found');
  });
  it('normalizes NFC and locale-independent case for full paths and names', async () => {
    const unicode = await makeLabel('Café', account, label), row = await write(1); await tag(row, unicode.id);
    expect((await search('label:"WORK/CAFE\u0301"')).ids).toEqual([row.id]);
    expect((await search('label:"CAFE\u0301"')).ids).toEqual([row.id]);
  });
  it('rejects duplicate short names and cross-account paths with only owned candidates', async () => {
    const root = await makeLabel('Root'); await makeLabel('Child', account, root);
    await makeLabel('Child', foreign);
    const ambiguous = await search('-label:child OR subject:hello', {}, 400);
    expect(ambiguous.code).toBe('ambiguous_label');
    expect(ambiguous.candidates.map(c => c.path).sort()).toEqual(['Root/Child', 'Work/Child']);
    await makeLabel('Work', second);
    expect((await search('label:work', {}, 400)).candidates).toHaveLength(2);
    expect((await search('label:work', { accountId: account.id })).labelIndex.resolvedReferences[0].labelId).toBe(label.id);
  });
  it('does not drop missing, foreign, deleted, disabled or opted-out references under NOT/OR', async () => {
    const secret = await makeLabel('Secret', foreign), excluded = await makeLabel('Excluded', second);
    await h.pool.query('UPDATE email_accounts SET include_in_unified_inbox=false WHERE id=$1', [second.id]);
    for (const value of ['missing', secret.id, excluded.id, randomUUID()])
      expect((await search(`-label:${value} OR subject:hello`, {}, 400)).code).toBe('label_not_found');
    expect((await search(`label:${excluded.id}`, { accountId: second.id })).labelIndex.resolvedReferences[0].accountId).toBe(second.id);
    await h.pool.query('UPDATE email_accounts SET enabled=false WHERE id=$1', [second.id]);
    expect((await search(`label:${excluded.id}`, { accountId: second.id }, 400)).code).toBe('label_not_found');
    await h.pool.query('DELETE FROM mail_labels WHERE id=$1', [child.id]);
    expect((await search(`-label:${child.id}`, {}, 400)).code).toBe('label_not_found');
  });
  it('includes verified other-account nonmembers under negation but never unknown identity', async () => {
    const member = await write(1), nonmember = await write(2), other = await write(3, { acct: second }); await tag(member);
    await write(4, { acct: foreign });
    await h.pool.query("INSERT INTO messages(account_id,uid,subject) VALUES ($1,99,'hello')", [account.id]);
    expect((await search('-label:work')).ids).toEqual([nonmember.id, other.id].sort());
    expect((await search('-label:work', { accountId: account.id })).ids).toEqual([nonmember.id]);
  });
  it('keeps exact current generations, epochs, present locations and canonical aliases', async () => {
    const canonical = await write(1), alias = await write(2), oldEpoch = await write(3, { folder: 'Archive' });
    const missing = await write(4), stale = await write(5, { acct: second });
    await tag(canonical); await tag(oldEpoch); await tag(missing);
    await h.pool.query('UPDATE message_entities SET canonical_entity_id=$1 WHERE id=$2', [canonical.entity_id, alias.entity_id]);
    await h.pool.query("UPDATE entity_locations SET status='missing' WHERE entity_id=$1", [missing.entity_id]);
    await h.pool.query("UPDATE mailbox_identity_epochs SET uid_validity=11 WHERE account_id=$1 AND folder_path='Archive'", [account.id]);
    await h.pool.query('UPDATE email_accounts SET storage_generation=$1 WHERE id=$2', [randomUUID(), second.id]);
    expect((await search('label:work')).ids).toEqual([canonical.id, alias.id].sort());
    const negative = await search('-label:work'); expect(negative.ids).not.toContain(stale.id);
    expect(negative.labelIndex).toMatchObject({ total: 5, known: 2, unavailable: 3, state: 'partial' });
  });
  it('preserves all three-valued combinations including mixed size and nested negation', async () => {
    const member = await write(1), nonmember = await write(2);
    await tag(member);
    const unknown = (await h.pool.query("INSERT INTO messages(account_id,uid,subject,rfc822_size_bytes) VALUES ($1,3,'hello',NULL) RETURNING *", [account.id])).rows[0];
    const refs = await resolveNativeLabelSearch(h.owner, [account.id], parseSearchExpression('label:work'), h.pool.query.bind(h.pool));
    const cases = [
      ['label:work', [true, false, null]], ['-label:work', [false, true, null]],
      ['-(-label:work)', [true, false, null]], ['label:work OR subject:hello', [true, true, true]],
      ['label:work OR subject:absent', [true, false, null]], ['label:work AND subject:absent', [false, false, false]],
      ['-(label:work AND subject:absent)', [true, true, true]],
      ['-(label:work OR subject:absent)', [false, true, null]],
      ['label:work AND larger:200', [false, false, null]],
      ['label:work OR larger:200', [true, false, null]],
      ['-(label:work AND larger:200)', [true, true, null]],
      ['-(-label:work OR -larger:200)', [false, false, null]],
    ];
    for (const [raw, expected] of cases) {
      const compiled = buildSearchConditions(raw, { firstParam: 2, nativeLabels: refs });
      const result = await h.pool.query(`SELECT ${compiled.conditions[0]} AS matched FROM messages m
        WHERE m.id=ANY($1::uuid[]) ORDER BY array_position($1::uuid[],m.id)`, [[member.id, nonmember.id, unknown.id], ...compiled.params]);
      expect(result.rows.map(row => row.matched), raw).toEqual(expected);
    }
  });
  it('preserves ordinary trash policy and physical row results unlike the entity-deduplicated feed', async () => {
    const one = await write(1, { providerId: 'same' }), two = await write(2, { providerId: 'same', folder: 'Archive' });
    const spam = await write(3, { folder: 'Spam' }), trash = await write(4, { folder: 'Trash' });
    await tag(one); await tag(spam); await tag(trash);
    await h.pool.query("INSERT INTO folders(account_id,path,name,special_use) VALUES ($1,'Trash','Trash','\\Trash') ON CONFLICT(account_id,path) DO UPDATE SET special_use=EXCLUDED.special_use", [account.id]);
    expect((await search('label:work')).ids).toEqual([one.id, two.id, spam.id].sort());
    expect((await search('label:work in:anywhere')).ids).toEqual([one.id, two.id, spam.id, trash.id].sort());
    const feed = await listNativeLabelMessages({ userId: h.owner, accountId: account.id, storageGeneration: account.storage_generation, labelId: label.id });
    expect(feed.messages).toHaveLength(1);
  });
  it('returns coverage for empty matches and later pages, alongside independent size coverage', async () => {
    await write(1); await h.pool.query("INSERT INTO messages(account_id,uid) VALUES ($1,2)", [account.id]);
    const result = await search('label:work larger:999', { offset: '50', folder: 'INBOX' });
    expect(result.messages).toEqual([]);
    expect(result.labelIndex).toMatchObject({ state: 'partial', total: 2, known: 1, unavailable: 1,
      scope: 'selected-folder-synchronized-cache', providerComplete: false, directMembershipOnly: true,
      accounts: expect.arrayContaining([{ accountId: account.id, storageGeneration: account.storage_generation, treeRevision: '0' }]) });
    expect(result.sizeIndex).toMatchObject({ state: 'partial', providerComplete: false });
    expect((await search('label:work', { folder: 'Empty' })).labelIndex).toMatchObject({ state: 'complete-for-cache', total: 0, known: 0 });
  });
  it('keeps UUID queries stable across rename and rejects stale paths and deleted UUIDs', async () => {
    const row = await write(1); await tag(row, child.id);
    await updateDefinition(h.owner, label.id, { accountId: account.id, mutationId: randomUUID(), expectedRevision: '1', name: 'Renamed' });
    const found = await search(`label:${child.id}`);
    expect(found.ids).toEqual([row.id]);
    expect(found.labelIndex.resolvedReferences[0]).toMatchObject({ path: 'Renamed/Child', treeRevision: '1' });
    expect((await search('label:"Work/Child"', {}, 400)).code).toBe('label_not_found');
    await deleteDefinition(h.owner, child.id, { accountId: account.id, mutationId: randomUUID(), expectedTreeRevision: '1', confirmSubtree: true });
    expect((await search(`-label:${child.id}`, {}, 400)).code).toBe('label_not_found');
  });
  it('holds one snapshot across concurrent definition deletion and membership/hydration reads', async () => {
    const row = await write(1); await tag(row, child.id);
    h.afterResolve = () => deleteDefinition(h.owner, child.id, { accountId: account.id, mutationId: randomUUID(), expectedTreeRevision: '0', confirmSubtree: true });
    const first = await search(`label:${child.id}`);
    expect(first.ids).toEqual([row.id]);
    expect(first.messages[0].nativeLabels.map(l => l.id)).toContain(child.id);
    expect(first.labelIndex.resolvedReferences[0].treeRevision).toBe('0');
    expect((await search(`label:${child.id}`, {}, 400)).code).toBe('label_not_found');
  });
  it('parameterizes punctuation and SQL-looking label names rather than interpolating them', async () => {
    const name = "x' OR true --", odd = await makeLabel(name), row = await write(1); await tag(row, odd.id);
    expect((await search(`label:"${name}"`)).ids).toEqual([row.id]);
    const tree = parseSearchExpression(`label:"${name}"`);
    const refs = await resolveNativeLabelSearch(h.owner, [account.id], tree, h.pool.query.bind(h.pool));
    const compiled = buildSearchConditions(`label:"${name}"`, { nativeLabels: refs });
    expect(compiled.conditions.join(' ')).not.toContain(name);
    expect(compiled.params).toEqual([account.id, account.storage_generation, odd.id]);
  });
  it('closes new native predicates to API tokens while preserving ordinary mail enrichment', async () => {
    const row = await write(1); await tag(row);
    for (const q of ['label:work', '-label:work OR subject:hello', 'label:missing']) {
      const rejected = await search(q, {}, 403, true);
      expect(rejected.code).toBe('native_label_scope_required');
      expect(rejected).not.toHaveProperty('candidates'); expect(rejected).not.toHaveProperty('labelIndex');
    }
    const normal = await search('subject:hello', {}, 200, true);
    expect(normal.ids).toEqual([row.id]);
    expect(normal.messages[0].nativeLabels.map(item => item.id)).toEqual([label.id]);
    expect(normal.messages[0].nativeLabelState).toBe('available');
  });
});
