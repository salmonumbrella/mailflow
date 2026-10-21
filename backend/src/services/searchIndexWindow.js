const position = row => {
  if (typeof row.id!=='string' || !(row.cursor_date===null || typeof row.cursor_date==='string')) {
    throw new Error('Source cursor requires exact database microsecond text or NULL');
  }
  return {id:row.id,date:row.cursor_date};
};

// Traversal positions are disposable. Jobs, leases and terminal evidence remain
// durable; a process restart safely starts at newest without discarding work.
export function createSearchIndexWindowTracker() {
  const accounts=new Map();
  return {
    rescan(accountId) {
      const state=accounts.get(accountId);
      if(state)accounts.set(accountId,{...state,next:'newest',high:null,newestHigh:null,newestAfter:null});
    },
    next(accountId,limit=50,context='') {
      if (!accounts.has(accountId)) accounts.set(accountId,{initialized:false,next:'newest',high:null,newestHigh:null,newestAfter:null,olderAfter:null,context});
      let state=accounts.get(accountId);
      if(state.context!==context){
        // A readiness/eligibility/contract change must revisit existing rows,
        // independently of date, while preserving ordinary older progress.
        state={...state,context,next:'newest',high:null,newestHigh:null,newestAfter:null};
        accounts.set(accountId,state);
      }
      return {accountId,track:state.next,limit:Math.max(1,Math.min(50,Math.trunc(Number(limit))||50)),
        after:state.next==='older'?state.olderAfter:state.newestAfter,
        above:state.next==='newest'&&state.initialized?state.high:null,token:state};
    },
    commit(plan,rows) {
      if (accounts.get(plan.accountId)!==plan.token) return false;
      if (rows.length>plan.limit) throw new Error('Source window exceeded its bound');
      const keys=rows.map(position),state=plan.token;
      const first=keys[0]||null,last=keys.at(-1)||null;
      let next;
      if (!state.initialized) {
        next={...state,initialized:true,high:first,olderAfter:last,next:'older'};
      } else if (plan.track==='older') {
        next={...state,olderAfter:last,next:'newest'};
      } else {
        const high=state.newestHigh||first;
        const complete=rows.length<plan.limit;
        next={...state,next:'older',high:complete?(high||state.high):state.high,
          newestHigh:complete?null:high,newestAfter:complete?null:last};
      }
      accounts.set(plan.accountId,next);
      return true;
    },
  };
}

// This is the actual bounded SQL used by the producer and EXPLAIN proof. The
// ordered account index supports both non-null and NULL-date continuations.
export function searchIndexWindowQuery(accountId,eligibility,plan) {
  const values=[accountId,eligibility.normalPaths,eligibility.archiveFolder];
  const common=`m.account_id=$1 AND m.is_deleted=false AND
    ((NOT m.is_archive_residue AND m.folder=ANY($2::text[])) OR (m.is_archive_residue AND m.folder=$3)) AND
    EXISTS (SELECT 1 FROM folders f WHERE f.account_id=m.account_id AND f.path=m.folder AND NOT f.no_select AND f.uid_validity IS NOT NULL)`;
  const boundary=(key,above,undated)=>{
    if(!key)return 'TRUE';
    if(key.date===null){
      if(!undated)return above?'TRUE':'FALSE';
      values.push(key.id);return `m.id${above?'>':'<'}$${values.length}::uuid`;
    }
    if(undated)return above?'FALSE':'TRUE';
    values.push(key.date,key.id);
    return `(m.date,m.id)${above?'>':'<'}($${values.length-1}::timestamptz,$${values.length}::uuid)`;
  };
  const dated=`${boundary(plan.after,false,false)} AND ${boundary(plan.above,true,false)}`;
  const undated=`${boundary(plan.after,false,true)} AND ${boundary(plan.above,true,true)}`;
  values.push(plan.limit);const cap=`$${values.length}`;
  const columns=`m.id,m.provider_msgid,m.folder,m.uid::text,m.date AS order_date,
    to_char(m.date AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_date`;
  return {text:`WITH dated_window AS MATERIALIZED (
      SELECT ${columns} FROM messages m WHERE ${common} AND m.date IS NOT NULL AND ${dated}
      ORDER BY m.date DESC NULLS LAST,m.id DESC LIMIT ${cap}
    ), undated_window AS (
      SELECT ${columns} FROM messages m WHERE ${common} AND m.date IS NULL AND ${undated}
      ORDER BY m.id DESC LIMIT (${cap}-(SELECT count(*) FROM dated_window))
    ) SELECT id,provider_msgid,folder,uid,cursor_date FROM (SELECT * FROM dated_window UNION ALL SELECT * FROM undated_window) w
      ORDER BY order_date DESC NULLS LAST,id DESC`,values};
}
