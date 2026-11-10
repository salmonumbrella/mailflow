import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
const h = vi.hoisted(() => ({ pool: null, pause: null }));
vi.mock('./db.js', () => ({
  pool: { connect: (...args) => h.pool.connect(...args) }, query: (...args) => h.pool.query(...args),
  withTransaction: async fn => {
    const client = await h.pool.connect();
    try {
      await client.query('BEGIN');
      const tx = { query: async (sql, params) => {
        const result = await client.query(sql, params);
        if (h.pause && /FROM email_accounts[\s\S]*FOR UPDATE/.test(sql)) { const pause = h.pause; h.pause = null; await pause(); }
        return result;
      } };
      const result = await fn(tx); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  },
}));
import { runMigrations } from './migrations.js';
import { createDefinition, deleteDefinition, previewDeletion } from './nativeLabelDefinitions.js';
import { saveNativeLabelRule } from './nativeLabelRulePersistence.js';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = promise => promise.then(result => ({ result }), error => ({ error }));
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('independent native rule activation/deletion PostgreSQL lock order', () => {
  const name = `mailflow_rule_lock_review_${randomBytes(5).toString('hex')}`;
  let admin, user, account, label, saved, body;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.MAILFLOW_TEST_DATABASE_URL); url.pathname = `/${name}`;
    h.pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
    await runMigrations();
  }, 60000);
  afterAll(async () => { await h.pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${name}`); await admin?.end(); });
  beforeEach(async () => {
    await h.pool.query('TRUNCATE users CASCADE');
    user = (await h.pool.query("INSERT INTO users(username) VALUES ('review-owner') RETURNING id")).rows[0].id;
    account = (await h.pool.query("INSERT INTO email_accounts(user_id,name,email_address) VALUES ($1,'Review','review@example.test') RETURNING *", [user])).rows[0];
    label = (await createDefinition(user, { accountId: account.id, mutationId: randomUUID(), name: 'Protected' })).result.label;
    body = { accountId: account.id, expectedStorageGeneration: account.storage_generation, enabled: false, conditionLogic: 'AND', conditions: [{ field: 'subject', operator: 'contains', value: 'invoice' }], actions: [{ type: 'apply_native_label', value: label.id }] };
    saved = await saveNativeLabelRule(user, null, body);
  });
  async function race(firstAction, secondAction) {
    const locked = deferred(), release = deferred();
    h.pause = async () => { locked.resolve(); await release.promise; };
    const first = settle(firstAction());
    await Promise.race([locked.promise, first.then(outcome => { if (outcome.error) throw outcome.error; throw new Error('First operation never acquired its account lock'); })]);
    const second = settle(secondAction());
    let waiting = false;
    try {
      for (let i = 0; i < 100; i++) {
        const { rows } = await h.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'");
        if (rows.length) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } finally { release.resolve(); }
    const results = await Promise.all([first, second]);
    expect(waiting, 'second real transaction waited behind the account lock').toBe(true);
    return results;
  }
  const enable = () => saveNativeLabelRule(user, saved.id, { ...body, enabled: true });
  const deletion = async () => {
    const preview = await previewDeletion(user, label.id, { accountId: account.id });
    return () => deleteDefinition(user, label.id, { accountId: account.id, expectedTreeRevision: preview.treeRevision, mutationId: randomUUID(), confirmSubtree: true });
  };
  it('delete winning the account lock prevents queued enable from adopting missing UUID references', async () => {
    const remove = await deletion();
    const [deleted, enabled] = await race(remove, enable);
    expect(deleted.error).toBeUndefined(); expect(enabled.error).toMatchObject({ code: 'missing_label_reference' });
    const current = (await h.pool.query('SELECT enabled,actions FROM inbox_rules WHERE id=$1', [saved.id])).rows[0];
    expect(current.enabled).toBe(false); expect(current.actions[0].value).toBe(label.id);
    expect((await h.pool.query('SELECT id FROM mail_labels WHERE id=$1', [label.id])).rows).toHaveLength(0);
  });
  it('enable winning the account lock blocks queued deletion, including a valid earlier deletion preview', async () => {
    const remove = await deletion();
    const [enabled, deleted] = await race(enable, remove);
    expect(enabled.error).toBeUndefined(); expect(deleted.error).toMatchObject({ code: 'label_referenced_by_rule' });
    expect((await h.pool.query('SELECT enabled FROM inbox_rules WHERE id=$1', [saved.id])).rows[0].enabled).toBe(true);
    expect((await h.pool.query('SELECT id FROM mail_labels WHERE id=$1', [label.id])).rows).toHaveLength(1);
  });
});
