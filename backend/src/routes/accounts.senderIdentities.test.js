import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../services/safeFetch.js', () => ({ safeFetch: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); } }));
vi.mock('../index.js', () => ({ imapManager: { clearConnectCooldown: vi.fn(), disconnectAccount: vi.fn().mockResolvedValue(), connectAccount: vi.fn().mockResolvedValue() } }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { collectHook: vi.fn().mockResolvedValue([]) } }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn().mockResolvedValue({}) }));
vi.mock('../services/imapManager.js', () => ({ providerProfile: () => ({ labelStore: false }) }));
vi.mock('../services/searchCoverage.js', () => ({ getSearchCoverage: vi.fn() }));
vi.mock('../services/searchIndexJobs.js', () => ({ setSearchCoverageAction: vi.fn() }));
// Signature HTML is outside credential/inventory behavior; avoid loading its parser stack.
vi.mock('../services/emailSanitizer.js', () => ({ sanitizeSignature: value => value }));
import express from 'express';
import routes from './accounts.js';
import { query } from '../services/db.js';
import { safeFetch } from '../services/safeFetch.js';
import { pluginRegistry } from '../plugins/registry.js';
import { encrypt, decrypt } from '../services/encryption.js';
import { fastmailConfigRevision, listProviderIdentities } from '../services/fastmailIdentities.js';

const id = '44444444-4444-4444-4444-444444444444', aliasId = '55555555-5555-5555-5555-555555555555';
let row, owned, alias, server, base;
beforeAll(async () => {
  process.env.ENCRYPTION_KEY = '71'.repeat(32);
  const app = express(); app.use(express.json()); app.use('/accounts', routes);
  // Keep Express's four-argument error-handler contract and delegate after headers.
  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    return res.status(err.status || 500).json({ error: err.message });
  });
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/accounts`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => {
  vi.clearAllMocks(); owned = true; alias = { id: aliasId, email: 'alias@synthetic.test', account_id: id };
  row = { id, user_id: 'user-1', email_address: 'owner@synthetic.test', auth_user: 'owner@synthetic.test',
    smtp_host: 'smtp.fastmail.com', enabled: true, fastmail_api_token: encrypt('synthetic-token') };
  query.mockImplementation(async (sql, values) => {
    if (sql.startsWith('UPDATE email_accounts')) {
      for (const [, column, n] of sql.matchAll(/(\w+) = \$(\d+)/g)) row[column] = values[n - 1];
      return { rows: [row] };
    }
    if (sql.includes('FROM email_accounts')) return { rows: owned ? [row] : [] };
    if (sql.includes('FROM account_aliases')) return { rows: alias ? [alias] : [] };
    throw new Error('Unexpected test query');
  });
  safeFetch.mockRejectedValue(new Error('offline'));
});
const put = body => fetch(`${base}/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

it('never exposes ciphertext to list/update output or enrichment hooks', async () => {
  const ciphertext = row.fastmail_api_token;
  const result = await (await fetch(base)).json();
  expect(result[0].fastmail_api_token_configured).toBe(true);
  expect(result[0].fastmail_config_revision).toBe(fastmailConfigRevision(row));
  expect(result[0].fastmail_verification_supported).toBe(true);
  expect(JSON.stringify(result)).not.toContain(ciphertext);
  const args = pluginRegistry.collectHook.mock.calls.find(([name]) => name === 'enrichAccount')[1];
  expect(args.account).not.toHaveProperty('fastmail_api_token');
  expect(JSON.stringify(args)).not.toContain('synthetic-token');
  const updated = await (await put({ name: 'Changed' })).json();
  expect(updated).not.toHaveProperty('fastmail_api_token');
  expect(updated.fastmail_config_revision).toBe(result[0].fastmail_config_revision);
});
it('preserves, encrypts replacement and explicitly clears token with matching safe revision', async () => {
  const original = row.fastmail_api_token;
  expect((await put({ name: 'Changed' })).status).toBe(200); expect(row.fastmail_api_token).toBe(original);
  const changed = await (await put({ fastmail_api_token: 'synthetic-token' })).json();
  expect(row.fastmail_api_token).not.toBe(original); expect(decrypt(row.fastmail_api_token)).toBe('synthetic-token');
  expect(changed.fastmail_config_revision).toBe(fastmailConfigRevision(row));
  expect(changed).not.toHaveProperty('fastmail_api_token');
  expect((await listProviderIdentities('user-1', id)).configRevision).toBe(changed.fastmail_config_revision);
  const cleared = await (await put({ fastmail_api_token: '' })).json();
  expect(row.fastmail_api_token).toBe(null); expect(cleared.fastmail_api_token_configured).toBe(false);
  expect(cleared.fastmail_config_revision).not.toBe(changed.fastmail_config_revision);
});
it.each([{}, null, 7, 'bad\ntoken', 'x'.repeat(4097)])('rejects malformed token before mutation', async value => {
  const response = await put({ fastmail_api_token: value });
  expect(response.status).toBe(400);
  expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
});
it.each(['foreign-account', 'missing-alias', 'invalid-alias'])('refuses %s before network with uniform 404', async kind => {
  if (kind === 'foreign-account') owned = false;
  if (kind === 'missing-alias') alias = null;
  const response = await fetch(`${base}/${id}/sender-identities?aliasId=${kind === 'invalid-alias' ? 'invalid' : aliasId}`);
  expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'Account not found' });
  expect(safeFetch).not.toHaveBeenCalled();
});
it('omitted alias means primary, supplied alias retains that sender even on unknown lookup', async () => {
  for (const [suffix, email] of [['', row.email_address], [`?aliasId=${aliasId}`, alias.email]]) {
    const response = await fetch(`${base}/${id}/sender-identities${suffix}`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const result = await response.json(); expect(result.sender).toEqual({ email, status: 'unknown' });
    expect(result).not.toHaveProperty('fastmail_api_token');
    expect(result.configRevision).toBe(fastmailConfigRevision(row));
  }
});
