import { isIdentityBootstrapComplete } from './archiveCoverage.js';
import { searchIndexEligibility, eligibleSearchIndexTarget } from './searchIndexEligibility.js';
import { createSearchIndexWindowTracker, searchIndexWindowQuery } from './searchIndexWindow.js';
import { enqueueSearchIndexJob, withSearchIndexAccount } from './searchIndexJobs.js';
import { searchSourceKey, searchSourceVersion, SOURCE_CONTRACT_GENERATION } from './searchIndexIdentity.js';

// These are producer/control transitions, not worker outcomes. The account and
// control locks exclude claims/publication; the captured row fence still binds
// each mutation to the exact token, epochs and contract generation inspected.
const ROW_FENCE = `j.account_id=$1 AND j.source_key=$2 AND j.lease_token IS NOT DISTINCT FROM $3::uuid
  AND j.lease_epoch=$4 AND j.run_epoch=$5 AND j.source_generation=$6
  AND (j.state<>'running' OR j.lease_expires_at<=now())
  AND EXISTS (SELECT 1 FROM search_index_accounts c JOIN email_accounts a ON a.id=c.account_id
    WHERE c.account_id=j.account_id AND c.run_epoch=$7 AND NOT c.paused AND a.enabled)`;
const params = (row, control) => [row.account_id,row.source_key,row.lease_token,row.lease_epoch,row.run_epoch,row.source_generation,control.run_epoch];
async function update(client, row, control, assignments, values = [], condition = 'TRUE') {
  const { rows } = await client.query(`UPDATE search_index_jobs j SET ${assignments} WHERE ${ROW_FENCE} AND (${condition}) RETURNING *`,
    [...params(row,control),...values]);
  return rows[0];
}
async function remove(client, row, control) {
  return client.query(`DELETE FROM search_index_jobs j WHERE ${ROW_FENCE}`,params(row,control));
}
const physicalKey = target => searchSourceKey({ folder:target.folder,uid:target.uid,uid_validity:target.uidValidity },false);
const sameLocator = (job, target) => job.message_id===target.id && job.folder===target.folder &&
  String(job.uid)===String(target.uid) && String(job.uid_validity)===String(target.uidValidity);
const newerContract = row => BigInt(row.source_generation)>BigInt(SOURCE_CONTRACT_GENERATION);
const currentQuote = row => row.pending_body_bytes!=null && row.pending_folder===row.folder &&
  String(row.pending_uid)===String(row.uid) && String(row.pending_uid_validity)===String(row.uid_validity);

async function transferPhysical(client, control, group, locked) {
  let changed=0;
  let provider=locked.find(row=>row.source_key===group.source_key);
  const physical=locked.filter(row=>row.source_key!==group.source_key);
  if (provider?.active || physical.some(row=>row.active)) return { skip:true,reason:'active-lease' };
  if (provider && newerContract(provider)) return { skip:true,reason:'newer-contract' };
  if (physical.some(newerContract)) return { skip:true,reason:'newer-contract' };
  if (!provider && physical.length) {
    // Terminal evidence wins the choice of rekey row. Its locator identifies
    // the measuring copy; the final representative can change independently.
    const chosen=physical.find(row=>row.state==='unsupported') || physical[0];
    const keepQuote=currentQuote(chosen);
    provider=await update(client,chosen,control,`source_key=$8,
      pending_folder=CASE WHEN $9 THEN pending_folder END,pending_uid=CASE WHEN $9 THEN pending_uid END,
      pending_uid_validity=CASE WHEN $9 THEN pending_uid_validity END,pending_body_bytes=CASE WHEN $9 THEN pending_body_bytes END`,
    [group.source_key,keepQuote]);
    if (!provider) return { skip:true };
    changed++;
    physical.splice(physical.indexOf(chosen),1);
  }
  for (const old of physical) {
    if (old.state==='unsupported' && String(old.source_generation)===String(provider.source_generation) && provider.state!=='complete') {
      provider=await update(client,provider,control,`state='unsupported',last_error=$8,
        unsupported_reason=$8,unsupported_folder=$9,unsupported_uid=$10,unsupported_uid_validity=$11,
        unsupported_source_generation=$12,observed_download_bytes=$13,structure_overrun_bytes=$14,
        lease_token=NULL,lease_expires_at=NULL,pending_folder=NULL,pending_uid=NULL,pending_uid_validity=NULL,pending_body_bytes=NULL`,
      [old.unsupported_reason,old.unsupported_folder,old.unsupported_uid,old.unsupported_uid_validity,
        old.unsupported_source_generation,old.observed_download_bytes,old.structure_overrun_bytes]);
      if (!provider) return { skip:true };
      changed++;
    } else if (old.state==='unsupported' && String(old.source_generation)===String(provider.source_generation)) {
      console.warn('Search index terminal evidence conflicts with an already complete provider source', {
        accountId:provider.account_id,sourceKey:provider.source_key,
      });
    }
    changed+=(await remove(client,old,control)).rowCount;
  }
  return { provider,changed };
}

// Both discovery entries use this one SQL projection and one fenced executor.
async function readSourceGroups(client,{accountId,identityReady,eligibility,window}) {
    const providerIds=[...new Set(window.filter(m=>identityReady&&m.provider_msgid).map(m=>m.provider_msgid))];
    const physicalIds=window.filter(m=>!identityReady||!m.provider_msgid).map(m=>m.id);
    const { rows:groups }=await client.query(`WITH live AS (
        SELECT m.id,m.folder,m.uid,f.uid_validity,m.date,m.search_generation_id,m.is_archive_residue,
          CASE WHEN $2 AND NULLIF(m.provider_msgid,'') IS NOT NULL THEN 'provider:'||m.provider_msgid
            ELSE 'physical:'||m.folder||':'||f.uid_validity::text||':'||m.uid::text END AS source_key
        FROM messages m JOIN folders f ON f.account_id=m.account_id AND f.path=m.folder
        WHERE m.account_id=$1 AND NOT m.is_deleted AND NOT f.no_select AND f.uid_validity IS NOT NULL
          AND ((NOT m.is_archive_residue AND f.path=ANY($3::text[])) OR (m.is_archive_residue AND f.path=$5))
          AND (($2 AND m.provider_msgid=ANY($6::text[])) OR m.id=ANY($7::uuid[]))
      ), grouped AS (
        SELECT l.source_key,
          jsonb_agg(jsonb_build_object('id',l.id,'folder',l.folder,'uid',l.uid::text,'uidValidity',l.uid_validity::text)
            ORDER BY l.is_archive_residue,l.folder COLLATE "C",l.uid,l.id) AS targets,max(l.date) AS newest,
          bool_and(g.id IS NOT NULL AND g.account_id=$1 AND g.source_key=
            concat('["7b",',to_json(l.source_key)::text,',',to_json($4::text)::text,']')) AS verified
        FROM live l LEFT JOIN search_text_generations g ON g.id=l.search_generation_id
        GROUP BY l.source_key
      ) SELECT g.* FROM grouped g LEFT JOIN search_index_jobs j ON j.account_id=$1 AND j.source_key=g.source_key
      WHERE (j.account_id IS NULL OR j.source_generation<$4::bigint OR (j.message_id,j.folder,j.uid,j.uid_validity) IS DISTINCT FROM
          ((g.targets->0->>'id')::uuid,g.targets->0->>'folder',(g.targets->0->>'uid')::bigint,(g.targets->0->>'uidValidity')::bigint)
        OR j.state='running' OR (j.state='complete' AND NOT g.verified)
        OR ($2 AND g.source_key LIKE 'provider:%' AND EXISTS (
          SELECT 1 FROM search_index_jobs p JOIN live l ON l.source_key=g.source_key
            AND p.source_key='physical:'||l.folder||':'||l.uid_validity::text||':'||l.uid::text
          WHERE p.account_id=$1)))
      ORDER BY g.newest DESC NULLS LAST,g.source_key`,
    [accountId,identityReady,eligibility.normalPaths,SOURCE_CONTRACT_GENERATION,eligibility.archiveFolder,providerIds,physicalIds]);
    return groups;
}

async function enqueueSourceGroups(client,control,groups,{accountId,identityReady,stopped}) {
    let changed=0,reason=null;
    for (const group of groups) {
      if (stopped()) {reason='stopped';break;}
      const targets=group.targets, representative=targets[0];
      const keys=[group.source_key,...(identityReady && group.source_key.startsWith('provider:') ? targets.map(physicalKey):[])];
      const { rows:locked }=await client.query(`SELECT j.*,(j.state='running' AND j.lease_expires_at>now()) AS active
        FROM search_index_jobs j WHERE j.account_id=$1 AND j.source_key=ANY($2::text[]) ORDER BY j.source_key FOR UPDATE OF j`,[accountId,keys]);
      let job=locked.find(row=>row.source_key===group.source_key);
      if (identityReady && group.source_key.startsWith('provider:')) {
        const transferred=await transferPhysical(client,control,group,locked);
        if (transferred.skip) {reason=transferred.reason||'stale-source';continue;}
        job=transferred.provider;
        changed+=transferred.changed;
      }
      if (job?.active) {reason='active-lease';continue;}
      if (job && newerContract(job)) {reason='newer-contract';continue;}
      if (job && BigInt(job.source_generation)<BigInt(SOURCE_CONTRACT_GENERATION)) {
        changed+=Number(await enqueueSearchIndexJob(accountId,{sourceKey:group.source_key,messageId:representative.id,
          folder:representative.folder,uid:representative.uid,uidValidity:representative.uidValidity,
          sourceGeneration:SOURCE_CONTRACT_GENERATION},{client}));
        continue;
      }
      if (job?.state==='unsupported' || (job?.state==='complete' && group.verified)) {
        // Unsupported provider content is terminal across representative changes;
        // unsupported_* remains evidence of the original measuring copy.
        if (!sameLocator(job,representative)) {
          await update(client,job,control,`message_id=$8,folder=$9,uid=$10,uid_validity=$11,
            pending_folder=NULL,pending_uid=NULL,pending_uid_validity=NULL,pending_body_bytes=NULL`,
          [representative.id,representative.folder,representative.uid,representative.uidValidity]);
          changed++;
        }
        continue;
      }
      if (!job || !sameLocator(job,representative)) {
        changed+=Number(await enqueueSearchIndexJob(accountId,{sourceKey:group.source_key,messageId:representative.id,
          folder:representative.folder,uid:representative.uid,uidValidity:representative.uidValidity,
          sourceGeneration:SOURCE_CONTRACT_GENERATION},{client}));
      } else if (job.state==='complete' && !group.verified) {
        // Publication cannot race while control is UPDATE-locked. Recheck live
        // current pointers in this UPDATE; the saved job generation_id is no proof.
        const reverified=await update(client,job,control,`state='queued',attempts=0,defer_at=NULL,last_error=NULL,
          lease_token=NULL,lease_expires_at=NULL,lease_epoch=lease_epoch+1,run_epoch=$7,
          pending_folder=NULL,pending_uid=NULL,pending_uid_validity=NULL,pending_body_bytes=NULL`,
        [JSON.stringify(targets),searchSourceVersion(job)],`EXISTS (
          SELECT 1 FROM jsonb_to_recordset($8::jsonb) AS t(id uuid,folder text,uid bigint,"uidValidity" bigint)
          JOIN messages m ON m.account_id=$1 AND m.id=t.id AND m.folder=t.folder AND m.uid=t.uid AND NOT m.is_deleted
          JOIN folders f ON f.account_id=m.account_id AND f.path=m.folder AND f.uid_validity=t."uidValidity"
          LEFT JOIN search_text_generations g ON g.id=m.search_generation_id
          WHERE g.id IS NULL OR g.account_id<>$1 OR g.source_key<>$9)`);
        if (reverified) changed++;
      }
    }
    return {changed,deferred:reason!==null,reason};
}

// The factory keeps date repair and targeted latency handoffs on the same
// disposable traversal state. The manager supplies its real lifecycle gate.
export function createSearchIndexSourceProducer({isOpen}={}) {
  if(typeof isOpen!=='function')throw new Error('Search source producer requires lifecycle isOpen');
  const windows=createSearchIndexWindowTracker();
  const stoppedResult=()=>({changed:0,rejected:0,deferred:true,reason:'stopped'});
  const closed=(account,signal)=>signal?.aborted || !isOpen(account.id);
  const metadata=async(account,profile)=>({identityReady:await isIdentityBootstrapComplete(account.id,profile),
    eligibility:await searchIndexEligibility(account.id,profile)});
  async function enqueueSearchIndexSources(account,{profile={},signal,limit=50}={}) {
    if(closed(account,signal))return stoppedResult();
    try{
      const info=await metadata(account,profile);
      if(closed(account,signal))return stoppedResult();
      let plan;
      const result=await withSearchIndexAccount(account.id,async(client,control)=>{
        if(closed(account,signal))return stoppedResult();
        const context=JSON.stringify([info.identityReady,SOURCE_CONTRACT_GENERATION,info.eligibility,String(control.run_epoch)]);
        plan=windows.next(account.id,limit,context);
        const statement=searchIndexWindowQuery(account.id,info.eligibility,plan);
        const {rows:window}=await client.query(statement.text,statement.values);
        const groups=await readSourceGroups(client,{accountId:account.id,...info,window});
        const outcomes=await enqueueSourceGroups(client,control,groups,{accountId:account.id,...info,stopped:()=>closed(account,signal)});
        return {...outcomes,window};
      });
      if(!result){windows.rescan(account.id);return stoppedResult();}
      // Per-group skips are processed metadata, not a reason to restart a pass.
      if(result.reason==='stopped' || closed(account,signal))windows.rescan(account.id);
      else if(plan)windows.commit(plan,result.window); // after COMMIT only
      const outcome={changed:result.changed,deferred:result.deferred,reason:result.reason};
      return closed(account,signal)?{...outcome,deferred:true,reason:'stopped'}:outcome;
    }catch(error){windows.rescan(account.id);throw error;}
  }
  enqueueSearchIndexSources.enqueueRows=async(account,ids,{profile={},signal}={})=>{
    if(!Array.isArray(ids)||ids.length>50)throw new Error('Search index handoff accepts at most50 row IDs');
    if(closed(account,signal))return stoppedResult();
    const unique=[...new Set(ids)];
    if(!unique.length)return{changed:0,rejected:0,deferred:false,reason:null};
    try{
      const info=await metadata(account,profile);
      if(closed(account,signal))return stoppedResult();
      const result=await withSearchIndexAccount(account.id,async(client,control)=>{
        if(closed(account,signal))return stoppedResult();
        const {rows:owned}=await client.query(`SELECT m.id,m.provider_msgid,m.folder,m.is_archive_residue,m.is_deleted,
            f.no_select,f.uid_validity
          FROM messages m LEFT JOIN folders f ON f.account_id=m.account_id AND f.path=m.folder
          WHERE m.account_id=$1 AND m.id=ANY($2::uuid[])`,[account.id,unique]);
        const visible=owned.filter(row=>!row.is_deleted);
        const rejected=unique.length-visible.length;
        // A visible Spam/Trash/nonselectable row is no work, not a failed handoff.
        const window=visible.filter(row=>!row.no_select && row.uid_validity!=null && eligibleSearchIndexTarget(row,info.eligibility));
        const groups=await readSourceGroups(client,{accountId:account.id,...info,window});
        const outcomes=await enqueueSourceGroups(client,control,groups,{accountId:account.id,...info,stopped:()=>closed(account,signal)});
        return {...outcomes,rejected};
      });
      if(!result){windows.rescan(account.id);return stoppedResult();}
      if(result.reason==='stopped' || closed(account,signal))windows.rescan(account.id);
      return closed(account,signal)?{...result,deferred:true,reason:'stopped'}:result;
    }catch(error){
      windows.rescan(account.id);
      return{changed:0,rejected:0,deferred:true,reason:'search-index-handoff-failed',detail:error.message};
    }
  };
  enqueueSearchIndexSources.rescan=accountId=>windows.rescan(accountId);
  return enqueueSearchIndexSources;
}

