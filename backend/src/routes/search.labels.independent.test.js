import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ query: vi.fn(), hydrate: vi.fn() }));
vi.mock('../services/db.js', () => ({ query: h.query, withTransaction: async fn => fn({ query: h.query }) }));
vi.mock('../services/nativeLabelReadModel.js', async original => ({ ...await original(), hydrateNativeLabels: h.hydrate }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'owner' }; if (req.get('x-token')) req.apiToken = { id: 'token' }; next(); } }));
import express from 'express';
import routes from './search.js';
const accountId = '00000000-0000-4000-8000-000000000001';
let server, base;
beforeAll(async () => { const app = express(); app.use(routes); await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${server.address().port}`; });
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  h.query.mockReset().mockImplementation(async sql => sql.includes('SELECT id, include_in_unified_inbox') ? { rows: [{ id: accountId, include_in_unified_inbox: true }] } : { rows: [{ id: 'mail', subject: 'invoice' }] });
  h.hydrate.mockReset().mockImplementation(async (_user, rows) => rows.map(row => ({ ...row, nativeLabels: [{ name: 'Local decision' }] })));
});
const request = (q, token = true) => fetch(`${base}/?${new URLSearchParams({ q })}`, { headers: token ? { 'x-token': 'yes' } : {} });
describe('independent native search access policy', () => {
  it('denies native predicates before resolving names or revealing candidates, including nested negation', async () => {
    for (const raw of ['label:Private', '-label:Private', 'subject:invoice OR -(label:Private AND larger:1)']) {
      h.query.mockClear();
      const response = await request(raw); expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'native_label_scope_required' });
      expect(h.query.mock.calls.every(([sql]) => !sql.includes('mail_labels'))).toBe(true);
      expect(h.hydrate).not.toHaveBeenCalled();
    }
  });
  it('ordinary token search retains existing read-mail metadata enrichment', async () => {
    const response = await request('subject:invoice'); expect(response.status).toBe(200);
    const body = await response.json(); expect(body.messages).toEqual([{ id: 'mail', subject: 'invoice', nativeLabels: [{ name: 'Local decision' }],
      attachmentMetadata: { state: 'unavailable', scope: 'message', source: null, items: [], omittedCount: null,
        providerComplete: false, inlineClassification: 'partial', sizeIsExact: false } }]);
    expect(h.query).toHaveBeenCalledTimes(2);
    expect(body).not.toHaveProperty('labelIndex'); expect(h.hydrate).toHaveBeenCalledOnce();
  });
  it('preserves browser hydration and treats a quoted literal label string as ordinary text', async () => {
    const response = await request('"label:Private"', false); expect(response.status).toBe(200);
    expect((await response.json()).messages[0].nativeLabels).toEqual([{ name: 'Local decision' }]);
    expect(h.hydrate).toHaveBeenCalledOnce();
  });
});
