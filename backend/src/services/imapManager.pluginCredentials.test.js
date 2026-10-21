import { expect, it, vi } from 'vitest';
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), parseMailboxList: vi.fn(() => [{ name: 'Hidden', email: 'hidden@example.test' }]), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((parsed) => parsed) }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./spamPipeline.js', () => ({ classifyAndTagMessage: vi.fn() }));
vi.mock('./mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));

import { ImapManager } from './imapManager.js';
import { pluginRegistry } from '../plugins/registry.js';

it('direct sync gates and ticks receive token-free copies while core keeps credentials', async () => {
  vi.useFakeTimers();
  const seen = [];
  const list = vi.spyOn(pluginRegistry, 'list').mockReturnValue([{ id: 'credential-test', sync: {
    intervalMs: 100,
    isActive: ({ account }) => { seen.push(account); return true; },
    tick: ({ account, mgr }) => { expect(mgr).toBe(manager.pluginFacade); seen.push(account); },
  } }]);
  const manager = Object.create(ImapManager.prototype);
  manager.pluginSyncIntervals = new Map(); manager.pluginFacade = {};
  const row = { id: 'synthetic-account', fastmail_api_token: 'enc:synthetic-secret', auth_pass: 'legacy-contract' };
  try {
    await manager._startPluginSyncTimers(row);
    await vi.advanceTimersByTimeAsync(200);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const account of seen) {
      expect(account).not.toHaveProperty('fastmail_api_token');
      expect(account).not.toBe(row);
      expect(account.auth_pass).toBe('legacy-contract');
    }
    expect(row.fastmail_api_token).toBe('enc:synthetic-secret');
  } finally { vi.clearAllTimers(); vi.useRealTimers(); list.mockRestore(); }
});
