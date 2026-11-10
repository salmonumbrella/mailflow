import { query } from './db.js';
import { rememberDroppedRows } from './movedRowCarry.js';
import { applyConfirmedMoveCache } from './messageMoveCache.js';
import { resolveArchiveFolder, isAllMailFolder, adjustFolderCounts } from '../utils/mailUtils.js';

// Archive a single INBOX copy of a message: the one guarded per-copy archive move, shared
// by any route that needs "move this INBOX row to the account's Archive and repoint the DB".
// The GTD /done handler owns the surrounding orchestration (mark-read → strip labels →
// archive, plus the partial-success response contract); this primitive owns ONLY the archive
// move itself so that archive semantics — the guard protocol, the Gmail All-Mail branch, the
// race-safe DB repoint, and the count adjustments — live in exactly one place.
//
// Contract, mirroring the move paths in mail.js and imapManager.js:
//   • No Archive folder configured is a SOFT outcome, not a failure: returns
//     { archived: false, noArchiveFolder: true } so the caller can leave the row alone
//     without treating it as an error (in /done the labels are already gone, so the thread
//     has left the rail regardless).
//   • The provider command requires the captured source identity. A source row that
//     changed before the cache write is left alone, with no duplicate count adjustment.
//   • Gmail's All Mail is excluded from sync/backfill and the relocate guard, so archiving
//     there just strips the INBOX row from our view: DELETE, not move+repoint, and no
//     destination count (All Mail counts aren't tracked).
//   • IMAP move failures THROW. A confirmed move with pending cache recovery returns
//     archived:true, identityPending:true so the caller does not retry a provider write.
//
// Guard protocol (ref-counted _guardMoveUid/_unguardMoveUid, byte-equivalent to the move
// paths): the source (INBOX, uid) is guarded for the whole move so reconcileDeletes can't
// treat the row as an orphan mid-flight; released in the finally so it is freed even when the
// move or write throws. On a non-UIDPLUS server the new destination uid is unknown, and the
// source uid at the destination can belong to another message (or to none, hiding the moved
// one). So the row is dropped instead of kept on that uid, and a sync of the destination files
// the message under its real uid; the destination's counts come from that sync.
// `fromFolder` defaults to INBOX. GTD's /done also passes a label folder, to archive a copy that
// is the message's only one instead of deleting it. The counts move the row's own unread, read
// back from the guarded write, so an unread copy archives unread.
export async function archiveInboxCopy(imapManager, account, inboxCopy, fromFolder = 'INBOX') {
  const capturedAccount = { ...account };
  const accountId = capturedAccount.id;
  const source = (await query(`SELECT m.*, a.storage_generation AS account_storage_generation
    FROM messages m JOIN email_accounts a ON a.id=m.account_id
    WHERE m.id=$1 AND m.account_id=$2 AND m.folder=$3 AND m.uid=$4`,
  [inboxCopy.id, accountId, fromFolder, inboxCopy.uid])).rows[0];
  if (!source) return { archived: false, noArchiveFolder: false };
  capturedAccount.storage_generation ??= source.account_storage_generation;
  const archiveFolder = await resolveArchiveFolder(accountId, capturedAccount.folder_mappings);
  if (!archiveFolder) return { archived: false, noArchiveFolder: true };

  const allMail = await isAllMailFolder(accountId, archiveFolder);
  imapManager._guardMoveUid(accountId, fromFolder, inboxCopy.uid);
  try {
    const newUid = await imapManager.moveMessage(capturedAccount, source.uid, fromFolder, archiveFolder,
      { expectedSource: source });
    try {
      const applied = await applyConfirmedMoveCache(capturedAccount, source, archiveFolder, newUid, {
        dropDestination: allMail,
        onApplied: async (tx, row, destinationKnown, destinationAlreadyCached, previousDestination) => {
          const unread = row.is_read === false ? 1 : 0;
          await adjustFolderCounts(accountId, fromFolder, -1, unread ? -1 : 0, tx.query.bind(tx));
          if (!allMail && destinationKnown) {
            const unreadDelta = unread - (destinationAlreadyCached ? Number(!previousDestination.is_read) : 0);
            await adjustFolderCounts(accountId, archiveFolder, destinationAlreadyCached ? 0 : 1, unreadDelta, tx.query.bind(tx));
          }
        },
      });
      if (applied.dropped?.length) rememberDroppedRows(archiveFolder, applied.dropped);
      if (applied.sync) {
        Promise.resolve(imapManager.syncFolderOnDemand(capturedAccount, archiveFolder))
          .catch(err => console.warn(`Archive: sync of ${archiveFolder} after a move failed: ${err.message}`));
      }
      // A resolved provider command must never become a retryable archive failure
      // merely because its journal/cache proof is still pending. Keep the exact
      // source in place when the helper cannot prove a safe local change.
      return { archived: true, noArchiveFolder: false, uidKnown: !applied.sync,
        ...(!applied.applied || applied.sync ? { identityPending: true } : {}) };
    } catch (err) {
      console.warn(`Archive cache recovery pending after confirmed move: ${err.message}`);
      return { archived: true, noArchiveFolder: false, uidKnown: false, identityPending: true };
    }
  } finally {
    imapManager._unguardMoveUid(accountId, fromFolder, inboxCopy.uid);
  }
}
