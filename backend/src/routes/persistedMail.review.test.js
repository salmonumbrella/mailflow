import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import session from 'express-session';

const data = vi.hoisted(() => ({ users: new Map(), tokens: new Map() }));
vi.mock('../services/db.js', () => {
  const query = vi.fn(async (sql, params = []) => {
    if (sql.includes("key = 'api_tokens_enabled'")) return { rows: [{ value: 'true' }] };
    if (sql.includes('WHERE t.token_hash = $1')) return { rows: data.tokens.has(params[0]) ? [data.tokens.get(params[0])] : [] };
    const user = data.users.get(params[0]);
    if (sql.startsWith('SELECT id FROM users')) return { rows: user ? [{ id: params[0] }] : [] };
    if (sql.startsWith('SELECT preferences FROM users')) return { rows: user ? [{ preferences: structuredClone(user) }] : [] };
    if (sql.startsWith("SELECT preferences->'snippets'")) return { rows: user ? [{ snippets: structuredClone(user.snippets ?? null) }] : [] };
    if (sql.startsWith('SELECT id, include_in_unified_inbox')) return { rows: [] };
    if (sql.startsWith('UPDATE users SET preferences = jsonb_set')) {
      if (user) user.snippets = JSON.parse(params[1]);
      return { rows: [], rowCount: user ? 1 : 0 };
    }
    if (sql.startsWith('UPDATE users\n')) {
      if (!user || (user.savedSplitsRevision || 0) !== params[2]) return { rows: [] };
      Object.assign(user, JSON.parse(params[1])); return { rows: [{ id: params[0] }] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { query, withTransaction: fn => fn({ query }) };
});
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/lastSeen.js', () => ({ touchLastSeen: vi.fn() }));
import { mountApiAuth } from '../middleware/apiChain.js';
import { buildSessionOptions } from '../utils/sessionConfig.js';
import { generateToken, hashToken, invalidateApiTokenSettingsCache } from '../services/apiTokens.js';
import snippets from './snippets.js';
import mutedThreads from './mutedThreads.js';
import search from './search.js';
import { getSavedSplits, putSavedSplits } from './savedSplitsPreferences.js';

let server, base;
const split = { id: 'work', label: 'Work', query: 'is:unread' };
const preferences = { savedSplits: [split], hideEmptySplits: false, savedSplitsRevision: 0 };
const snippet = { title: 'Hello', body: 'Fictional test text' };
const endpoints = [
  ['GET', '/api/snippets'], ['POST', '/api/snippets', snippet],
  ['PUT', '/api/snippets/11111111-1111-4111-8111-111111111111', { ...snippet, version: 1 }],
  ['DELETE', '/api/snippets/11111111-1111-4111-8111-111111111111?version=1'],
  ['POST', '/api/snippets/11111111-1111-4111-8111-111111111111/use', { requestId: '22222222-2222-4222-8222-222222222222' }],
  ['GET', '/api/auth/preferences/saved-splits'], ['PUT', '/api/auth/preferences/saved-splits', preferences],
  ['GET', '/api/search/splits'],
  ['GET', '/api/mail/muted'],
  ['GET', '/api/mail/messages/11111111-1111-4111-8111-111111111111/mute'],
  ['PATCH', '/api/mail/messages/11111111-1111-4111-8111-111111111111/mute', { muted: true, revision: null }],
];
const call = (method, path, body, headers = {}) => fetch(base + path, {
  method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'review-test', ...headers },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const login = async user => (await fetch(`${base}/login/${user}`)).headers.get('set-cookie').split(';')[0];
beforeAll(async () => {
  const app = express();
  mountApiAuth(app, session(buildSessionOptions(new session.MemoryStore(), 'review-secret-'.padEnd(40, 'x'))));
  app.get('/login/:user', (req, res) => { req.session.userId = req.params.user; res.json({ ok: true }); });
  app.get('/lock', (req, res) => { req.session.locked = true; res.json({ ok: true }); });
  app.use('/api/snippets', snippets); app.use('/api/search', search); app.use('/api/mail', mutedThreads);
  app.get('/api/auth/preferences/saved-splits', getSavedSplits);
  app.put('/api/auth/preferences/saved-splits', putSavedSplits);
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  data.users = new Map([['alice', structuredClone(preferences)], ['bob', {}]]); data.tokens.clear(); invalidateApiTokenSettingsCache();
});
it('all persisted mail endpoints reject anonymous sessions', async () => {
  for (const endpoint of endpoints) expect((await call(...endpoint)).status).toBe(401);
});
it('all persisted mail endpoints reject a locked session, including read and count routes', async () => {
  const Cookie = await login('alice'); await fetch(base + '/lock', { headers: { Cookie } });
  for (const [method, path, body] of endpoints) expect((await call(method, path, body, { Cookie })).status).toBe(423);
  expect(data.users.get('alice')).toEqual(preferences);
});
it('browser writes require the CSRF header, then persist only under the authenticated owner', async () => {
  const Cookie = await login('alice');
  for (const [method, path, body] of endpoints.filter(([method]) => method !== 'GET')) {
    const response = await fetch(base + path, { method, headers: { Cookie, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect(response.status).toBe(403);
  }
  expect((await call('POST', '/api/snippets', { ...snippet, userId: 'bob' }, { Cookie })).status).toBe(201);
  expect((await call('PUT', '/api/auth/preferences/saved-splits', { ...preferences, userId: 'bob' }, { Cookie })).status).toBe(200);
  expect(data.users.get('alice').snippets).toHaveLength(1); expect(data.users.get('alice').savedSplitsRevision).toBe(1);
  expect(data.users.get('bob')).toEqual({});
  const BobCookie = await login('bob');
  expect((await (await call('GET', '/api/snippets', null, { Cookie: BobCookie })).json()).snippets).toEqual([]);
  expect((await (await call('GET', '/api/auth/preferences/saved-splits', null, { Cookie: BobCookie })).json()).savedSplits).toEqual([]);
});
it('even an all-scopes valid API token cannot access new persisted feature endpoints or fall back to a browser cookie', async () => {
  const token = generateToken(); data.tokens.set(hashToken(token), { id: 'test-token', user_id: 'bob', username: 'bob', scopes: ['read', 'organize', 'draft'], expired: false });
  const Cookie = await login('alice');
  for (const [method, path, body] of endpoints) expect((await call(method, path, body, { Cookie, Authorization: `Bearer ${token}` })).status).toBe(403);
  expect(data.users.get('alice')).toEqual(preferences); expect(data.users.get('bob')).toEqual({});
});
