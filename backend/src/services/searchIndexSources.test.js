import { describe,expect,it,vi } from 'vitest';
vi.mock('./db.js',()=>({query:vi.fn(),withTransaction:vi.fn()}));
import { createSearchIndexSourceProducer } from './searchIndexSources.js';
import { runSearchIndexBatch } from './searchIndexWorker.js';
import { query,withTransaction } from './db.js';

describe('required search discovery lifecycle contracts',()=>{
  it.each([undefined,null,42])('rejects a missing or nonfunction factory isOpen: %s',value=>{
    expect(()=>createSearchIndexSourceProducer({isOpen:value})).toThrow('isOpen');
  });
  it('rejects a worker with no bound enqueueRows before any extraction or database work',async()=>{
    const fetchMessageBody=vi.fn();
    await expect(runSearchIndexBatch({id:'contract-account'},{fetchMessageBody})).rejects.toThrow('enqueueRows');
    expect(fetchMessageBody).not.toHaveBeenCalled();expect(query).not.toHaveBeenCalled();expect(withTransaction).not.toHaveBeenCalled();
  });
});
