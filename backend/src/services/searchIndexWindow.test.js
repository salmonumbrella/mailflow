import { describe,expect,it } from 'vitest';
import { createSearchIndexWindowTracker } from './searchIndexWindow.js';

const row=(id,date='2026-10-21T12:00:00.123456Z')=>({id,cursor_date:date});

describe('bounded source window traversal',()=>{
  it('catches a multi-window newest burst while the older traversal keeps its position',()=>{
    const tracker=createSearchIndexWindowTracker();
    tracker.commit(tracker.next('a',2),[row('b'),row('a')]);
    const older=tracker.next('a',2);expect(older.track).toBe('older');expect(older.after.id).toBe('a');
    tracker.commit(older,[row('9'),row('8')]);
    const newest=tracker.next('a',2);expect(newest.above.id).toBe('b');expect(newest.after).toBeNull();
    tracker.commit(newest,[row('f'),row('e')]);
    const nextOlder=tracker.next('a',2);expect(nextOlder.after.id).toBe('8');tracker.commit(nextOlder,[row('7'),row('6')]);
    const catchup=tracker.next('a',2);expect(catchup.track).toBe('newest');expect(catchup.after.id).toBe('e');expect(catchup.above.id).toBe('b');
    tracker.commit(catchup,[row('d'),row('c')]);
    tracker.commit(tracker.next('a',2),[row('5'),row('4')]);
    const exhausted=tracker.next('a',2);expect(exhausted.after.id).toBe('c');expect(exhausted.above.id).toBe('b');tracker.commit(exhausted,[]);
    const unchangedOlder=tracker.next('a',2);expect(unchangedOlder.after.id).toBe('4');tracker.commit(unchangedOlder,[]);
    expect(tracker.next('a',2).above.id).toBe('f');
  });

  it('preserves exact microsecond text and separates NULL-date positions',()=>{
    const tracker=createSearchIndexWindowTracker();
    tracker.commit(tracker.next('a',2),[row('a','2026-10-21T12:00:00.123457Z'),row('b','2026-10-21T12:00:00.123456Z')]);
    expect(tracker.next('a',2).after).toEqual({id:'b',date:'2026-10-21T12:00:00.123456Z'});
    tracker.commit(tracker.next('a',2),[row('c',null)]);
    tracker.commit(tracker.next('a',2),[]);
    expect(tracker.next('a',2).after).toEqual({id:'c',date:null});
  });

  it('does not advance an aborted, failed or paused window unless its successful commit is acknowledged',()=>{
    const tracker=createSearchIndexWindowTracker();const initial=tracker.next('a',2);
    expect(tracker.next('a',2)).toMatchObject({track:initial.track,after:initial.after,above:initial.above});
    tracker.commit(initial,[row('b'),row('a')]);const waiting=tracker.next('a',2);
    for(let i=0;i<3;i++)expect(tracker.next('a',2)).toMatchObject({track:waiting.track,after:waiting.after,above:waiting.above});
  });

  it('rejects a stale concurrent acknowledgement instead of replacing newer traversal progress',()=>{
    const tracker=createSearchIndexWindowTracker();const first=tracker.next('a',2),stale=tracker.next('a',2);
    expect(tracker.commit(first,[row('b'),row('a')])).toBe(true);
    expect(tracker.commit(stale,[row('z'),row('y')])).toBe(false);
    expect(tracker.next('a',2)).toMatchObject({track:'older',after:{id:'a'}});
  });

  it('wraps old traversal and keeps interleaved accounts independent',()=>{
    const tracker=createSearchIndexWindowTracker();
    tracker.commit(tracker.next('a',2),[row('b'),row('a')]);tracker.commit(tracker.next('b',2),[row('8'),row('7')]);
    tracker.commit(tracker.next('a',2),[]);
    expect(tracker.next('b',2).after.id).toBe('7');
    tracker.commit(tracker.next('a',2),[]);
    expect(tracker.next('a',2)).toMatchObject({track:'older',after:null});
    expect(createSearchIndexWindowTracker().next('a',2)).toMatchObject({track:'newest',after:null,above:null});
  });

  it('rescans existing dates on identity readiness change without resetting older progress',()=>{
    const tracker=createSearchIndexWindowTracker();tracker.commit(tracker.next('a',2,'physical'),[row('b'),row('a')]);
    tracker.commit(tracker.next('a',2,'physical'),[row('9'),row('8')]);
    const regroup=tracker.next('a',2,'provider');expect(regroup).toMatchObject({track:'newest',after:null,above:null});
    tracker.commit(regroup,[row('b'),row('a')]);
    expect(tracker.next('a',2,'provider')).toMatchObject({track:'older',after:{id:'8'}});
  });

  it('refuses a Date cursor or a window larger than its declared bound',()=>{
    const tracker=createSearchIndexWindowTracker();const plan=tracker.next('a',1);
    expect(()=>tracker.commit(plan,[row('a',new Date())])).toThrow('microsecond');
    expect(()=>tracker.commit(plan,[row('a'),row('b')])).toThrow('window');
    expect(tracker.next('a',1)).toMatchObject({track:'newest',after:null});
  });

  it('explicitly rescans newest while preserving older progress and rejecting an old acknowledgement',()=>{
    const tracker=createSearchIndexWindowTracker();
    tracker.commit(tracker.next('a',2),[row('b'),row('a')]);
    tracker.commit(tracker.next('a',2),[row('9'),row('8')]);
    const stale=tracker.next('a',2);tracker.rescan('a');
    expect(tracker.commit(stale,[row('z')])).toBe(false);
    const renewed=tracker.next('a',2);expect(renewed).toMatchObject({track:'newest',after:null,above:null});
    tracker.commit(renewed,[row('b'),row('a')]);
    expect(tracker.next('a',2)).toMatchObject({track:'older',after:{id:'8'}});
  });

  it('keeps run epochs as exact context strings above 2^53',()=>{
    const tracker=createSearchIndexWindowTracker();
    tracker.commit(tracker.next('a',2,'9007199254740992'),[row('b'),row('a')]);
    const renewed=tracker.next('a',2,'9007199254740993');
    expect(renewed).toMatchObject({track:'newest',after:null,above:null});
    tracker.commit(renewed,[row('b'),row('a')]);
    expect(tracker.next('a',2,'9007199254740993')).toMatchObject({track:'older',after:{id:'a'}});
  });

});
