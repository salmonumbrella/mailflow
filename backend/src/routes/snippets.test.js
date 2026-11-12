import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

const db = vi.hoisted(() => ({ users: new Map(), calls: [] }));
vi.mock('../services/db.js', () => {
  const query = vi.fn(async (sql, values) => {
    db.calls.push([sql, values]);
    const user = db.users.get(values[0]);
    if (sql.startsWith('SELECT id FROM users')) return { rows: user ? [{ id: values[0] }] : [] };
    if (sql.startsWith("SELECT preferences->'snippets'")) return { rows: user ? [{ snippets: structuredClone(user.snippets ?? null) }] : [] };
    if (sql.startsWith('UPDATE users SET preferences = jsonb_set')) {
      if (user) user.snippets = JSON.parse(values[1]);
      return { rows: [], rowCount: user ? 1 : 0 };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { query, withTransaction: fn => fn({ query }) };
});
vi.mock('../services/lastSeen.js', () => ({ touchLastSeen: vi.fn() }));
import snippetRoutes from './snippets.js';
import { validateSnippet } from '../services/mailSnippets.js';

let server, base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId: req.get('x-test-user'), destroy: () => {} }; next(); });
  app.use('/api/snippets', snippetRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: 'Internal server error' }));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/snippets`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => { db.users = new Map([['alice', { theme: 'dark' }], ['bob', { theme: 'light' }]]); db.calls = []; });
const call = async (method, suffix = '', body, user = 'alice') => {
  const res = await fetch(base + suffix, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const draft = { title: 'Follow up', body: 'Thanks!\nNext steps are below.' };

describe('authenticated snippets', () => {
  it('rejects unauthenticated and deleted-user access', async () => {
    for (const user of [null, 'missing']) {
      expect((await call('GET', '', null, user)).status).toBe(401);
      expect((await call('POST', '', draft, user)).status).toBe(401);
    }
  });

  it('persists create, edit, list, delete with stable IDs and versions', async () => {
    expect((await call('GET')).body).toEqual({ snippets: [] });
    const created = await call('POST', '', draft);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ ...draft, version: 1, format: 'text' });
    const updated = await call('PUT', `/${created.body.id}`, { title: 'Updated', body: '<img src=x onerror=alert(1)>', version: 1 });
    expect(updated.body).toMatchObject({ id: created.body.id, title: 'Updated', body: '<img src=x onerror=alert(1)>', version: 2, format: 'text' });
    expect((await call('GET')).body.snippets).toEqual([updated.body]);
    expect((await call('DELETE', `/${created.body.id}?version=2`)).status).toBe(204);
    expect((await call('GET')).body.snippets).toEqual([]);
    expect(db.users.get('alice').theme).toBe('dark');
    expect(db.calls.some(([sql]) => sql.endsWith('FOR UPDATE'))).toBe(true);
  });

  it('cannot read, change or delete another user’s snippet, even with an owner in the body', async () => {
    const created = (await call('POST', '', { ...draft, userId: 'bob' })).body;
    expect((await call('GET', '', null, 'bob')).body.snippets).toEqual([]);
    expect((await call('PUT', `/${created.id}`, { ...draft, version: 1, userId: 'alice' }, 'bob')).status).toBe(404);
    expect((await call('DELETE', `/${created.id}?version=1`, null, 'bob')).status).toBe(404);
    expect((await call('GET')).body.snippets).toHaveLength(1);
  });

  it('refuses stale updates and deletions without losing newer edits', async () => {
    const { body: created } = await call('POST', '', draft);
    expect((await call('PUT', `/${created.id}`, { ...draft, title: 'Newer', version: 1 })).status).toBe(200);
    expect((await call('PUT', `/${created.id}`, { ...draft, version: 1 })).status).toBe(409);
    expect((await call('DELETE', `/${created.id}?version=1`)).status).toBe(409);
    expect((await call('GET')).body.snippets[0].title).toBe('Newer');
  });

  it('bounds collection size', async () => {
    db.users.get('alice').snippets = Array.from({ length: 50 }, (_, i) => ({ id: String(i), ...draft, version: 1 }));
    expect((await call('POST', '', draft)).status).toBe(409);
    expect(db.users.get('alice').snippets).toHaveLength(50);
  });

  it('rejects bad shape, blank/oversized text, controls, HTML format, bad IDs and missing version', async () => {
    for (const input of [{}, { title: 42, body: 'Body' }, { title: ' ', body: 'Body' }, { title: 'x'.repeat(121), body: 'Body' }, { title: 'Title', body: 'x'.repeat(20001) }, { ...draft, body: '\u0000bad' }, { ...draft, title: 'bad\ntitle' }, { ...draft, format: 'html' }, { ...draft, body: '\ud800' }, { ...draft, subject: 'x'.repeat(201) }, { ...draft, subject: 'Injected\r\nHeader: x' }, { ...draft, subject: 1 }]) {
      expect((await call('POST', '', input)).status).toBe(400);
    }
    expect((await call('PUT', '/invalid', { ...draft, version: 1 })).status).toBe(400);
    const { body: created } = await call('POST', '', draft);
    expect((await call('PUT', `/${created.id}`, draft)).status).toBe(400);
    expect((await call('DELETE', `/${created.id}`)).status).toBe(400);
  });
});

it('normalizes CRLF, trims titles and treats HTML-looking content only as plain text', () => {
  expect(validateSnippet({ title: ' Title ', body: '<script>\r\ntext' })).toEqual({ title: 'Title', subject: '', body: '<script>\ntext', format: 'text' });
  for (const input of [null, [], 'text']) expect(() => validateSnippet(input)).toThrow();
});


it('records explicit use once per request ID without changing content revisions or other users', async () => {
  const { body: created } = await call('POST', '', { ...draft, subject: 'Actual subject' });
  expect(created.subject).toBe('Actual subject'); expect(created.usageCount).toBe(0); expect(created.lastUsedAt).toBeNull();
  await call('GET'); await call('GET');
  expect((await call('GET')).body.snippets[0].usageCount).toBe(0);
  const requestId = '22222222-2222-4222-8222-222222222222';
  expect((await call('POST', `/${created.id}/use`, { requestId }, 'bob')).status).toBe(404);
  expect((await call('POST', `/${created.id}/use`, { requestId }, null)).status).toBe(401);
  expect((await call('POST', `/${created.id}/use`, {})).status).toBe(400);
  const used = await call('POST', `/${created.id}/use`, { requestId });
  expect(used.status).toBe(200); expect(used.body.usageCount).toBe(1); expect(used.body.lastUsedAt).toBeTruthy();
  expect(used.body.version).toBe(created.version); expect(used.body.updatedAt).toBe(created.updatedAt);
  expect(used.body).not.toHaveProperty('usageRequestIds');
  expect((await call('POST', `/${created.id}/use`, { requestId })).body.usageCount).toBe(1);
  const edited = (await call('PUT', `/${created.id}`, { ...draft, version: 1 })).body;
  expect(edited.version).toBe(2); expect(edited.usageCount).toBe(1); expect(edited.lastUsedAt).toBe(used.body.lastUsedAt);
  expect((await call('POST', `/${created.id}/use`, { requestId })).body.usageCount).toBe(1);
  expect((await call('GET')).body.snippets[0]).not.toHaveProperty('usageRequestIds');
});
