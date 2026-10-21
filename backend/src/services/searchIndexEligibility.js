import { query } from './db.js';
import { isBackfillFolder } from './archiveCoverage.js';

// Use the cached special-use folder selected by the existing archive contract:
// enabled account, selectable \All, path order. No display-name guessing.
export async function searchIndexEligibility(accountId,profile) {
  const {rows}=await query(`SELECT f.path,f.special_use,f.no_select,f.uid_validity FROM folders f
    JOIN email_accounts a ON a.id=f.account_id WHERE f.account_id=$1 AND a.enabled ORDER BY f.path`,[accountId]);
  const archiveFolder=profile.labelStore?rows.find(f=>!f.no_select&&f.special_use==='\\All')?.path||null:null;
  const normalPaths=rows.filter(f=>!f.no_select && !(profile.labelStore&&f.special_use==='\\All') && isBackfillFolder(f.path,profile)).map(f=>f.path);
  return {normalPaths,archiveFolder};
}

export function eligibleSearchIndexTarget(row,{normalPaths,archiveFolder}) {
  return row.is_archive_residue ? archiveFolder!==null&&row.folder===archiveFolder : normalPaths.includes(row.folder);
}
