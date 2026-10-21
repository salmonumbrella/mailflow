import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
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


import { EventEmitter } from 'node:events';
import { ImapFlow } from 'imapflow';
import { ImapManager } from './imapManager.js';
import { query, withTransaction } from './db.js';
import { parseMessage } from './messageParser.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { resolveForConnection } from './hostValidation.js';

// AUTHORING ONLY. Real manager methods, scripted IMAP and metadata transaction
// boundary; this does not establish the SQL discriminator's real-PG proof.
// No fabricated search_index_arrival result flag or xmax-derived classifier.
describe('phase1 identity-union CTE committed-id handoff',()=>{
  let account, manager, client, state, errors;
  const rowId='11111111-1111-4111-8111-111111111111';
  const idFor=uid=>uid===5?rowId:'00000000-0000-4000-8000-'+String(uid).padStart(12,'0');
  const result=(uid=5)=>({id:idFor(uid),account_id:account.id,provider_msgid:state.afterProvider,
    is_deleted:state.deleted,is_archive_residue:false,is_new:state.legacyNew});
  const finish=async (pending,mode)=>{
    let settled=false;
    const result=Promise.resolve(pending);
    result.then(()=>{settled=true;},()=>{settled=true;});
    // Sync needs only promise/zero-delay work. Gmail backfill has at most two
    // batches in these fixtures, each followed by its existing 2000ms delay.
    await vi.advanceTimersByTimeAsync(mode==='backfill'?4000:0);
    expect(settled).toBe(true);
    return result;
  };
  const invoke=mode=>mode==='sync'
    ? manager.syncMessages(account,client,'Work',50,false,true)
    : manager.backfillMessages(account,'Work');
  beforeEach(()=>{
    vi.useFakeTimers();vi.clearAllMocks();
    account={id:'22222222-2222-4222-8222-222222222222',user_id:'phase1-owner',
      email_address:'owner@example.test',enabled:true,imap_host:'imap.gmail.com',
      imap_port:993,imap_tls:true,auth_user:'owner',auth_pass:'enc',
      categorization_enabled:false,gtd_enabled:false};
    state={prior:null,afterProvider:'9007199254740993',legacyNew:false,deleted:false,
      inTransaction:false,committed:false,reachedCommit:false,writeStarted:false,
      writeError:null,commitError:null,commitHold:null,serverUids:[5],cachedUids:[],maxKnown:0,storedModseq:null,
      committedIds:[],writeUids:[],failUid:null};
    client=Object.assign(new EventEmitter(),{usable:true,capabilities:new Set(),
      mailbox:{exists:1,uidValidity:7},connect:vi.fn(async()=>{}),
      close:vi.fn(),logout:vi.fn(async()=>{}),noop:vi.fn(async()=>{}),
      getMailboxLock:vi.fn(async()=>({release:vi.fn()})),search:vi.fn(async()=>state.serverUids.slice()),
      fetch:vi.fn(async function* (range){
        const text=String(range);
        let wanted;
        if(text.includes(':')){
          const [from,to]=text.split(':');
          wanted=state.serverUids.filter(uid=>uid>=Number(from)&&(to==='*'||uid<=Number(to)));
        }else wanted=text.split(',').map(Number).filter(uid=>state.serverUids.includes(uid));
        for(const uid of wanted)yield {uid,flags:new Set(['\\Seen'])};
      })});
    ImapFlow.mockImplementation(function(){return client;});
    getConnectionPolicy.mockResolvedValue({allowPrivateHosts:true,allowInsecureTls:true});
    resolveForConnection.mockResolvedValue({host:'127.0.0.1',addresses:['127.0.0.1'],servername:null});
    parseMessage.mockImplementation(async m=>({uid:m.uid,messageId:'<phase1@example.test>',
      subject:'phase1',fromEmail:'sender@example.test',to:[],cc:[],replyTo:[],
      date:new Date('2026-10-21T00:00:00Z'),isRead:true,isStarred:false,
      flags:['\\Seen'],parsedHeaders:{},isBulk:true,providerMsgid:state.afterProvider}));
    manager=new ImapManager(null);
    // This suite exercises explicit metadata methods, not recurring schedulers.
    // disconnectAccount/quiesceSearchIndex do not dispose constructor intervals.
    for(const key of ['_folderStatusTimer','_healthCheckTimer','_snippetSchedulerTimer',
      '_stalenessCheckTimer','_flagPushReconcilerTimer'])clearInterval(manager[key]);
    expect(vi.getTimerCount()).toBe(0);
    manager.broadcast=vi.fn();
    manager.maybeClassifyNewMessage=vi.fn();manager._noteSecondaryRefusal=vi.fn();
    manager.enqueueCommittedSearchRows=vi.fn(async(a,ids)=>{
      expect(state.committed).toBe(true);
      expect(state.inTransaction).toBe(false);expect(a.id).toBe(account.id);
      expect(ids.length).toBeLessThanOrEqual(500);
      expect(ids.every(id=>state.committedIds.includes(id))).toBe(true);
      return {changed:1,rejected:0,deferred:false,reason:null};
    });
    vi.spyOn(console,'warn').mockImplementation(()=>{});
    errors=vi.spyOn(console,'error').mockImplementation(()=>{});
    vi.spyOn(console,'log').mockImplementation(()=>{});
    withTransaction.mockImplementation(async fn=>{
      state.inTransaction=true;
      try{
        const result=await fn({query});state.reachedCommit=true;
        if(state.commitHold)await state.commitHold;
        if(state.commitError)throw state.commitError;
        state.committed=true;
        if(result.rows?.[0]?.id)state.committedIds.push(result.rows[0].id);
        return result;
      }finally{state.inTransaction=false;}
    });
    query.mockImplementation(async(sql,params=[])=>{
      if(sql.includes('FROM email_accounts')&&!sql.includes('COUNT('))return {rows:[account]};
      if(sql.includes('SELECT path,uid_validity,special_use FROM folders'))return {rows:[{path:'Work',uid_validity:'7',special_use:null}]};
      if(sql.includes('SELECT uid_validity'))return {rows:[{uid_validity:'7',highest_modseq:state.storedModseq}]};
      if(sql.includes('COALESCE(MAX(uid), 0)')&&!sql.includes('COUNT(*)'))return {rows:[{max_uid:state.maxKnown}]};
      if(sql.includes('COUNT(*) as count'))return {rows:[{count:String(state.cachedUids.length),max_uid:state.maxKnown}]};
      if(sql.includes('COUNT(*) FILTER'))return {rows:[{n:'0'}]};
      if(sql.includes('SELECT uid FROM messages'))return {rows:state.cachedUids.map(uid=>({uid}))};
      if(sql.includes('INSERT INTO messages')||(sql.includes('UPDATE messages')&&sql.includes('RETURNING'))){
        state.writeStarted=true;const uid=Number(params[1]);state.writeUids.push(uid);
        if(state.writeError)throw state.writeError;
        if(uid===state.failUid)throw new Error('selected metadata write failed');
        if(!state.inTransaction){
          state.reachedCommit=true;
          if(state.commitHold)await state.commitHold;
          if(state.commitError)throw state.commitError;
          state.committed=true;state.committedIds.push(idFor(uid));
        }
        const prior=state.prior?.id===idFor(uid)?state.prior:null;
        const written=sql.includes('WITH prior AS')
          ? {...result(uid),inserted_row:prior===null,prior_provider_msgid:prior?.provider_msgid??null}
          : {id:idFor(uid),is_new:state.legacyNew};
        return {rows:[written],rowCount:1};
      }
      return {rows:[],rowCount:0};
    });
  });
  afterEach(async()=>{
    try{await manager?.quiesceSearchIndex();}
    finally{vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();}
  });
  const batch=ids=>{
    state.serverUids=[1,...ids];state.cachedUids=[1];state.maxKnown=1;state.storedModseq='500';
    client.mailbox.exists=state.serverUids.length;client.mailbox.highestModseq=500n;
  };
  for(const mode of ['sync','backfill']){
    it(`${mode}: hands off a real inserted id despite a false legacy is_new`,async()=>{
      for(const provider of [null,'9007199254740993']){
        state.afterProvider=provider;state.committed=false;state.reachedCommit=false;
        manager.enqueueCommittedSearchRows.mockClear();
        await finish(invoke(mode),mode);
        expect(state.committed).toBe(true);
        expect(manager.enqueueCommittedSearchRows).toHaveBeenCalledOnce();
      }
    });
    it(`${mode}: excludes an ordinary refresh despite a true legacy is_new`,async()=>{
      state.prior={...result(),provider_msgid:state.afterProvider};state.legacyNew=true;
      await finish(invoke(mode),mode);
      expect(state.committed).toBe(true);expect(manager.enqueueCommittedSearchRows).not.toHaveBeenCalled();
    });
    it.each([null,'old-opaque-provider'])(`${mode}: hands off actual provider transition from %s`,async prior=>{
      state.prior={...result(),provider_msgid:prior};
      await finish(invoke(mode),mode);
      expect(manager.enqueueCommittedSearchRows).toHaveBeenCalledOnce();
    });
    it(`${mode}: excludes a retained deleted row`,async()=>{
      state.deleted=true;state.prior={...result(),provider_msgid:'old-provider'};state.legacyNew=true;
      await finish(invoke(mode),mode);expect(manager.enqueueCommittedSearchRows).not.toHaveBeenCalled();
    });
    it(`${mode}: waits for the OUTERMOST identity writer COMMIT before handing off`,async()=>{
      let release;state.commitHold=new Promise(done=>{release=done;});
      const pending=invoke(mode);
      try{
        await vi.waitFor(()=>expect(state.reachedCommit).toBe(true));
        expect(state.writeStarted).toBe(true);expect(state.committed).toBe(false);
        expect(manager.enqueueCommittedSearchRows).not.toHaveBeenCalled();
      }finally{release();await finish(pending,mode);}
      expect(manager.enqueueCommittedSearchRows).toHaveBeenCalledOnce();
    });
    it.each(['write rollback','commit-result rejection'])(`${mode}: emits no id on %s`,async failure=>{
      if(failure==='write rollback')state.writeError=new Error('synthetic write failure');
      else state.commitError=new Error('synthetic COMMIT failure');
      await finish(invoke(mode),mode);
      expect(state.committed).toBe(false);expect(manager.enqueueCommittedSearchRows).not.toHaveBeenCalled();
      expect(manager._noteSecondaryRefusal).not.toHaveBeenCalled();
    });
    it.each(['ordinary storage failure','disk quota storage failure','authentication-shaped storage failure'])(`${mode}: preserves committed ingest after handoff throws %s`,async detail=>{
        state.legacyNew=true;
        manager.enqueueCommittedSearchRows.mockImplementation(async()=>{throw new Error(detail);});
        const value=await finish(invoke(mode),mode);
        expect(state.committed).toBe(true);expect(manager.enqueueCommittedSearchRows).toHaveBeenCalledOnce();
        expect(manager._noteSecondaryRefusal).not.toHaveBeenCalled();expect(errors).not.toHaveBeenCalled();
        expect(withTransaction).toHaveBeenCalled();
        if(mode==='sync')expect(value).toEqual({insertedCount:1,broadcastedNewMessages:false});
        else expect(value).toBeUndefined();
        for(const [payload] of manager.broadcast.mock.calls)expect(payload).not.toHaveProperty('admittedIds');
      });
    it(`${mode}: does not manufacture an id for a missing UID`,async()=>{
      parseMessage.mockResolvedValue({uid:null});await finish(invoke(mode),mode);
      expect(state.writeStarted).toBe(false);expect(manager.enqueueCommittedSearchRows).not.toHaveBeenCalled();
    });
    it(mode+': H1 batches 501 committed arrivals into ordered 500 and 1 calls',async()=>{
      const arrivals=Array.from({length:501},(_,i)=>i+2);batch(arrivals);
      await finish(invoke(mode),mode);
      const order=mode==='backfill'?arrivals.slice().reverse():arrivals;
      expect(state.writeUids).toEqual(order);
      expect(manager.enqueueCommittedSearchRows).toHaveBeenCalledTimes(2);
      const calls=manager.enqueueCommittedSearchRows.mock.calls;
      expect(calls.map(([,ids])=>ids.length)).toEqual([500,1]);
      expect(calls.flatMap(([,ids])=>ids)).toEqual(order.map(idFor));
      expect(state.committedIds).toEqual(order.map(idFor));
    });
    it(mode+': H1 flushes only committed IDs after a mid-batch write failure',async()=>{
      batch([5,6,7]);state.failUid=6;
      await finish(invoke(mode),mode);
      const committed=(mode==='backfill'?[7,5]:[5,7]).map(idFor);
      expect(state.committedIds).toEqual(committed);
      expect(manager.enqueueCommittedSearchRows).toHaveBeenCalledOnce();
      expect(manager.enqueueCommittedSearchRows).toHaveBeenCalledWith(account,committed);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(manager._noteSecondaryRefusal).not.toHaveBeenCalled();
    });
    it(mode+': H1 a held handoff cannot delay the next metadata write in its batch',async()=>{
      batch([5,6]);let release;
      const hold=new Promise(done=>{release=done;});
      const committed=(mode==='backfill'?[6,5]:[5,6]).map(idFor);
      manager.enqueueCommittedSearchRows.mockImplementation(async(a,ids)=>{
        expect(a.id).toBe(account.id);expect(ids).toEqual(committed);
        expect(state.inTransaction).toBe(false);expect(state.committedIds).toEqual(committed);
        await hold;return {changed:1,rejected:0,deferred:false,reason:null};
      });
      const pending=invoke(mode);
      try{
        await vi.waitFor(()=>expect(manager.enqueueCommittedSearchRows).toHaveBeenCalledOnce());
        expect(state.writeUids).toHaveLength(2);expect(state.committedIds).toEqual(committed);
      }finally{release();await finish(pending,mode);}
      expect(manager.enqueueCommittedSearchRows).toHaveBeenCalledOnce();
    });

  }
});
