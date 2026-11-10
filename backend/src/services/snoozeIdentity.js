// Aliases are flattened by proved reconciliation. A current cache coordinate must
// also have its exact present location in the current mailbox epoch.
export const currentSnoozeMessageSql = (s = 'sm', m = 'm') => `
  ${s}.wake_state='ready' AND ${s}.storage_generation=${m}.storage_generation
  AND ${s}.storage_generation=(SELECT storage_generation FROM email_accounts WHERE id=${s}.account_id)
  AND ${s}.account_id=${m}.account_id AND ${s}.snoozed_folder=${m}.folder
  AND ${m}.is_deleted = false
  AND ${m}.entity_id=(SELECT COALESCE(se.canonical_entity_id,se.id) FROM message_entities se
    WHERE se.account_id=${s}.account_id AND se.storage_generation=${s}.storage_generation AND se.id=${s}.entity_id)
  AND EXISTS (SELECT 1 FROM entity_locations sl JOIN mailbox_identity_epochs ep
    USING (account_id,storage_generation,folder_path,uid_validity)
    WHERE sl.account_id=${m}.account_id AND sl.storage_generation=${m}.storage_generation
      AND sl.folder_path=${m}.folder AND sl.uid_validity=${m}.uid_validity
      AND sl.uid=${m}.uid AND sl.entity_id=${m}.entity_id AND sl.status='present')`;
export const LIVE_SNOOZE_SQL = `EXISTS (SELECT 1 FROM messages m WHERE ${currentSnoozeMessageSql()})`;
