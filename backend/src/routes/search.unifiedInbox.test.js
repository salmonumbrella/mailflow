import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));

import express from 'express';
import { openReplyFromMessage } from '../../../frontend/src/utils/composeFromMessage.js';
import searchRoutes from './search.js';
import { query } from '../services/db.js';

function buildApp() {
  const app = express();
  app.use('/api/search', searchRoutes);
  return app;
}

describe('GET /api/search unified account scope', () => {
  let server;
  let base;

  beforeAll(async () => {
    await new Promise(resolve => {
      server = buildApp().listen(0, resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    query.mockReset();
  });

  it('searches only opted-in accounts when no account is selected', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          { id: 'included', include_in_unified_inbox: true },
          { id: 'excluded', include_in_unified_inbox: false },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/api/search?q=invoice`);

    expect(response.status).toBe(200);
    expect(query.mock.calls[1][1][0]).toEqual(['included']);
  });

  it('keeps an opted-out account searchable when explicitly selected', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ id: 'excluded', include_in_unified_inbox: false }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/api/search?q=invoice&accountId=excluded`);

    expect(response.status).toBe(200);
    expect(query.mock.calls[1][1][0]).toEqual(['excluded']);
  });

  it.each([true, false])('projects stored reply metadata for compose (populated=%s)', async populated => {
    const accountId = '11111111-1111-4111-8111-111111111111';
    const generation = '22222222-2222-4222-8222-222222222222';
    const row = {
      id: '33333333-3333-4333-8333-333333333333', account_id: accountId, from_email: 'sender@example.test',
      reply_to: populated ? [{ email: 'reply@example.test' }] : [],
      delivery_addresses: populated ? ['alias@example.test'] : [], thread_id: populated ? 'synthetic-thread' : null,
    };
    query.mockResolvedValueOnce({ rows: [{ id: accountId }] })
      .mockResolvedValueOnce({ rows: [row] })
      // The cache row has no verified entity. Execute real hydration with its
      // account's generation, rather than bypassing it through a non-UUID fixture.
      .mockResolvedValueOnce({ rows: [{ request_index: 0, id: row.id, storage_generation: generation }] });
    const response = await fetch(`${base}/api/search?q=synthetic`);
    expect(response.status).toBe(200);
    const sql = query.mock.calls[1][0].split('FROM messages')[0];
    for (const field of ['reply_to', 'delivery_addresses', 'thread_id', 'entity_id', 'storage_generation', 'uid_validity']) expect(sql).toContain(`m.${field}`);
    const { messages } = await response.json();
    expect(messages).toEqual([{ ...row, entityId: null, storageGeneration: generation, metadataVersion: null,
      nativeLabelState: 'unavailable', nativeLabelScope: 'message', nativeLabels: null,
      attachmentMetadata: { state: 'unavailable', scope: 'message', source: null, items: [], omittedCount: null,
        providerComplete: false, inlineClassification: 'partial', sizeIsExact: false } }]);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2][0]).toContain('WITH requested AS');
    expect(query.mock.calls[2][1][0]).toBe('user-1');
    expect(JSON.parse(query.mock.calls[2][1][1])).toEqual([{ request_index: 0, id: row.id, account_id: accountId }]);
    let draft;
    await openReplyFromMessage(messages[0], {
      accounts: [{ id: accountId, email_address: 'owner@example.test', aliases: [{ id: 'alias', email: 'alias@example.test' }] }],
      openCompose: p => { draft = p; }, getMessageBody: async () => null,
    });
    expect(draft.to.map(a => a.email)).toEqual([populated ? 'reply@example.test' : 'sender@example.test']);
    expect(draft.aliasId).toBe(populated ? 'alias' : null);
    expect(draft.threadId).toBe(row.thread_id);
  });

});
