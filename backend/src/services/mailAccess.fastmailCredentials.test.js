import { expect, it, vi } from 'vitest';
vi.mock('./db.js', () => ({ query: vi.fn() }));
import { query } from './db.js';
import { getOwnedAccount } from './mailAccess.js';

it('returns an ownership-checked copy without the Fastmail token through the plugin read capability', async () => {
  const row = { id: 'synthetic-account', fastmail_api_token: 'enc:synthetic-secret', auth_pass: 'legacy-contract' };
  query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [] });
  const result = await getOwnedAccount('owner', row.id);
  expect(query).toHaveBeenNthCalledWith(1,
    'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [row.id, 'owner']);
  expect(result).toEqual({ id: row.id, auth_pass: 'legacy-contract' });
  expect(result).not.toBe(row);
  expect(row.fastmail_api_token).toBe('enc:synthetic-secret');
  expect(await getOwnedAccount('foreign', row.id)).toBe(null);
  expect(query).toHaveBeenNthCalledWith(2,
    'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [row.id, 'foreign']);
});
