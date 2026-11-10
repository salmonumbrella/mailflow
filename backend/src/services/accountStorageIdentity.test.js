import { describe, expect, it } from 'vitest';
import { accountStorageSelectors, storageSelectorsChanged } from './accountStorageIdentity.js';

const account = { imap_host: 'IMAP.Example.com.', imap_port: 993, auth_user: 'User', email_address: 'me@example.com' };
describe('effective storage selectors', () => {
  it('normalizes host, port and username whitespace without collapsing username case', () => {
    expect(storageSelectorsChanged(account, { imap_host: ' imap.example.com ', imap_port: '993', auth_user: ' User ' })).toBe(false);
    expect(storageSelectorsChanged(account, { auth_user: 'user' })).toBe(true);
  });
  it('does not infer a new mailbox from credentials, TLS, SMTP or display settings', () => {
    expect(storageSelectorsChanged(account, { auth_pass: 'new', oauth_access_token: 'new', imap_tls: false, smtp_host: 'other', name: 'Other' })).toBe(false);
  });
  it('matches OAuth email fallback, but not password auth fallback', () => {
    expect(accountStorageSelectors({ ...account, oauth_provider: 'google', auth_user: null }).user).toBe(account.email_address);
    expect(accountStorageSelectors({ ...account, auth_user: null }).user).toBe('');
    expect(storageSelectorsChanged({ ...account, oauth_provider: 'microsoft', auth_user: null }, { auth_user: account.email_address })).toBe(false);
  });
  it('treats absent ports consistently on non-IMAP metadata edits', () => {
    expect(storageSelectorsChanged({}, { name: 'New name' })).toBe(false);
  });
});
