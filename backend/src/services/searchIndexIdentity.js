// A contract revision, never a mailbox UIDVALIDITY, reclaim or session epoch.
export const SOURCE_CONTRACT_GENERATION = '0';

// The caller obtains identityReady from the existing global bootstrap helper.
// Account identity is the other half of the jobs table's composite primary key.
export function searchSourceKey(row, identityReady) {
  return identityReady && row.provider_msgid
    ? `provider:${row.provider_msgid}`
    : `physical:${row.folder}:${row.uid_validity}:${row.uid}`;
}

export function searchSourceVersion(claim) {
  return JSON.stringify(['7b', claim.source_key, String(claim.source_generation)]);
}
