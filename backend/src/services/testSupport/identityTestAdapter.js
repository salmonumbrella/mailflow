// Isolate pre-existing content SQL/provider mechanics tests from the durable identity
// schema. Real identity transactions and engine wiring have dedicated regression suites.
import { vi } from 'vitest';
import { query } from '../db.js';
export const providerIdentityNamespace = client => client.capabilities?.has('OBJECTID') ? 'imap-objectid'
  : client.capabilities?.has('X-GM-EXT-1') ? 'gmail-x-gm-msgid' : null;
export const readMailboxIdentity = vi.fn(async (account, folderPath) => ({ accountId: account.id, folderPath }));
export const observeMailboxIdentity = vi.fn(async (snapshot, client) => ({ ...snapshot,
  uidValidity: client.mailbox?.uidValidity == null ? null : String(client.mailbox.uidValidity),
  providerNamespace: client.capabilities?.has('OBJECTID') ? 'imap-objectid'
    : client.capabilities?.has('X-GM-EXT-1') ? 'gmail-x-gm-msgid' : null,
  epochChanged: false, purgedCount: 0 }));
export const assertMailboxIdentity = vi.fn(async () => {});
export const writeObservedMessage = vi.fn(async (_context, _message, callback) => callback({ query }));
export const writeUnverifiedMessage = vi.fn(async (_account, _folder, _uid, callback) => callback({ query }));
export const prepareIdentityOperations = vi.fn(async (_context, _folder, uids) => uids.map(uid => ({ uid })));
export const prepareAppendIdentityOperation = vi.fn(async () => ({ id: 'append-operation' }));
export const completeIdentityOperations = vi.fn(async operations => operations);

export const withMailboxIdentity = vi.fn(async (_context, callback) => callback({ query }));
export const withAccountIdentity = vi.fn(async (_account, callback) => callback({ query }));

export const assertExpectedSource = vi.fn(async () => {});
export const captureMessageSource = vi.fn(async (account, folderPath, uid, expectedSource) => ({
  context: { accountId: account.id, storageGeneration: account.storage_generation, folderPath },
  expectedSource: expectedSource ?? { uid, folder: folderPath },
}));

export const assertExpectedSources = vi.fn(async()=>{});
export const captureMessageSources = vi.fn(async(account,folderPath,uids,expectedSources)=>({
  context:{accountId:account.id,storageGeneration:account.storage_generation,folderPath},
  expectedSources:expectedSources ?? uids.map(uid=>({uid,folder:folderPath,account_id:account.id})),
}));
