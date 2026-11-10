import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFixtureState, createFixtureServer, handleFixtureApi } from './superhuman-fixture-server.mjs';

const call = (state, method, url, body) => { const u = new URL(url, 'http://127.0.0.1'); return handleFixtureApi(state, method, u.pathname, u.searchParams, body); };

test('fixture identities and messages are fictional and instances are isolated', () => {
  const a = createFixtureState(), b = createFixtureState();
  for (const account of a.accounts) assert.match(account.email_address, /\.example$/);
  for (const message of a.messages) {
    assert.match(message.from_email, /\.example$/);
    assert.match(message.message_id, /\.example>$/);
    for (const recipient of message.to_addresses) assert.match(recipient.address, /\.example$/);
    for (const recipient of message.to_addresses) assert.equal(recipient.email, recipient.address);
  }
  a.messages[0].subject = 'Changed only in memory';
  assert.notEqual(a.messages[0].subject, b.messages[0].subject);
  assert.deepEqual(a.sent, []);
});

test('fixture native mail routes preserve account, category, search and action semantics', () => {
  const state = createFixtureState();
  assert.equal(call(state, 'GET', '/api/mail/messages').body.total, 9);
  assert.equal(call(state, 'GET', '/api/mail/messages?accountId=fixture-personal').body.total, 2);
  assert.equal(call(state, 'GET', '/api/mail/messages?category=primary').body.total, 5);
  assert.equal(call(state, 'GET', '/api/search?q=launch').body.messages[0].id, 'fixture-message-1');
  assert.equal(call(state, 'GET', '/api/search?q=from%3A%22maya%40northstar.example%22').body.messages[0].id, 'fixture-message-1');
  assert.equal(call(state, 'GET', '/api/search?q=subject%3Alaunch%20is%3Aunread').body.total, 1);
  assert.equal(call(state, 'GET', '/api/search?q=subject%3Alaunch%20is%3Aread').body.total, 0);
  assert.equal(call(state, 'GET', '/api/search?q=subject%3Alaunch%20-is%3Astarred').body.total, 0);
  const id = 'fixture-message-1';
  call(state, 'POST', '/api/mail/messages/bulk-read', { ids: [id], read: true });
  call(state, 'PATCH', `/api/mail/messages/${id}/star`, { starred: false });
  assert.equal(state.messages[0].is_read, true);
  assert.equal(state.messages[0].is_starred, false);
  call(state, 'POST', '/api/mail/messages/bulk-archive', { ids: [id] });
  assert.equal(call(state, 'GET', '/api/search?q=subject%3Alaunch%20in%3Aall&folder=INBOX').body.total, 1);
  assert.equal(call(state, 'GET', '/api/search?q=subject%3Alaunch&folder=INBOX').body.total, 0);
  assert.equal(call(state, 'GET', '/api/mail/messages?accountId=fixture-work&folder=Archive').body.total, 1);
  call(state, 'POST', '/api/mail/messages/bulk-move', { ids: [id], folder: 'INBOX' });
  call(state, 'POST', `/api/mail/messages/${id}/snooze`, { until: '2026-11-11T09:00:00Z' });
  assert.equal(call(state, 'GET', '/api/mail/messages?folder=Snoozed').body.total, 1);
  call(state, 'POST', `/api/mail/messages/${id}/unsnooze`, {});
  assert.equal(state.messages[0].folder, 'INBOX');
  assert.equal(state.messages[0].snooze_until, undefined);
  assert.equal(state.mutations.length, 6);
});

test('send paths refuse delivery, unsupported actions fail closed, and drafts remain in memory', () => {
  const state = createFixtureState();
  const send = call(state, 'POST', '/api/mail/send', { to: 'recipient@example.com', text: 'Not deliverable' });
  assert.equal(send.status, 409);
  assert.match(send.body.error, /No message was sent/);
  assert.equal(state.sent[0].delivered, false);
  assert.equal(call(state, 'POST', '/api/accounts', { host: 'production.example.com' }).status, 501);
  assert.equal(call(state, 'POST', '/api/mail/draft', { to: 'maya@northstar.example', text: 'Draft' }).status, 200);
  assert.equal(state.drafts.length, 1);
});

test('saved split fixtures keep revision conflicts and native inbox/account scope', () => {
  const state = createFixtureState();
  assert.equal(call(state, 'GET', '/api/auth/preferences/saved-splits').body.savedSplitsRevision, 0);
  const body = { savedSplits: [{ id: 'launch', label: 'Launch', query: 'launch' }], hideEmptySplits: true, savedSplitsRevision: 0 };
  assert.equal(call(state, 'PUT', '/api/auth/preferences/saved-splits', body).status, 200);
  assert.equal(call(state, 'PUT', '/api/auth/preferences/saved-splits', body).status, 409);
  assert.equal(state.preferences.theme, 'dark');
  assert.deepEqual(call(state, 'GET', '/api/search/splits').body.counts.launch, { total: 1, unread: 1 });
  assert.equal(call(state, 'GET', '/api/search/splits?accountId=fixture-personal').body.counts.launch.total, 0);
  state.messages[0].folder = 'Archive';
  assert.equal(call(state, 'GET', '/api/search/splits').body.counts.launch.total, 0);
  assert.equal(call(state, 'PUT', '/api/auth/preferences/saved-splits', { ...body, savedSplitsRevision: 1, savedSplits: [body.savedSplits[0], body.savedSplits[0]] }).status, 400);
});

test('snippet fixtures are in-memory CRUD with stale-version rejection and no delivery', () => {
  const state = createFixtureState();
  const created = call(state, 'POST', '/api/snippets', { title: 'Hello', body: 'Hello there' });
  assert.equal(created.status, 201);
  assert.equal(call(state, 'GET', '/api/snippets').body.snippets.length, 1);
  const id = created.body.id;
  assert.equal(call(state, 'PUT', `/api/snippets/${id}`, { title: 'Updated', body: 'New text', version: 1 }).body.version, 2);
  assert.equal(call(state, 'DELETE', `/api/snippets/${id}?version=1`).status, 409);
  assert.equal(call(state, 'DELETE', `/api/snippets/${id}?version=2`).status, 204);
  assert.equal(call(state, 'GET', '/api/snippets').body.snippets.length, 0);
  assert.equal(call(state, 'POST', '/api/snippets', { title: 'Bad', body: '\u0000' }).status, 400);
  assert.deepEqual(state.sent, []);
});

test('snippet fixture subjects and explicit-use metadata preserve content versions and never send', () => {
  const state = createFixtureState();
  const created = call(state, 'POST', '/api/snippets', { title: 'Internal label', subject: 'Authored subject', body: '<img src=x>\nNext' }).body;
  assert.equal(created.subject, 'Authored subject'); assert.equal(created.usageCount, 0); assert.equal(created.lastUsedAt, null); assert.ok(created.updatedAt);
  const path = `/api/snippets/${created.id}/use`;
  const requestId = '22222222-2222-4222-8222-222222222222';
  call(state, 'GET', '/api/snippets'); assert.equal(state.snippets[0].usageCount, 0);
  const used = call(state, 'POST', path, { requestId }).body;
  assert.equal(used.usageCount, 1); assert.ok(used.lastUsedAt); assert.equal(used.updatedAt, created.updatedAt); assert.equal(used.version, 1);
  assert.equal(call(state, 'POST', path, { requestId }).body.usageCount, 1);
  assert.equal(call(state, 'POST', path, {}).status, 400);
  assert.equal(call(state, 'POST', '/api/snippets/33333333-3333-4333-8333-333333333333/use', { requestId }).status, 404);
  const edited = call(state, 'PUT', `/api/snippets/${created.id}`, { title: 'Changed label', subject: 'New subject', body: 'Edited body', version: 1 }).body;
  assert.equal(edited.usageCount, 1); assert.equal(edited.lastUsedAt, used.lastUsedAt); assert.equal(edited.version, 2);
  assert.equal(call(state, 'POST', path, { requestId }).body.usageCount, 1);
  assert.equal(call(state, 'GET', '/api/snippets').body.snippets[0].usageRequestIds, undefined);
  for (const subject of ['a'.repeat(201), 'Header\r\nInjected: x']) assert.equal(call(state, 'POST', '/api/snippets', { title: 'Label', subject, body: 'Text' }).status, 400);
  assert.deepEqual(state.sent, []);
});

test('local calendar fixture is explicitly enabled, empty, range-bounded and revision checked', () => {
  const state = createFixtureState();
  assert.equal(call(state, 'GET', '/api/local-calendar/catalog').status, 403);
  assert.equal(call(state, 'PATCH', '/api/plugins/local-calendar', { activated: true }).status, 200);
  assert.deepEqual(call(state, 'GET', '/api/local-calendar/catalog').body.calendars, []);
  const catalog = call(state, 'PUT', '/api/local-calendar/catalog', { calendars: [{ id: 'local', name: 'Personal', color: '#7565e8' }], templates: [], timezone: 'UTC', weekStart: 1, revision: null });
  assert.equal(catalog.status, 200);
  assert.equal(call(state, 'PUT', '/api/local-calendar/catalog', { ...catalog.body, revision: null }).status, 409);
  const event = call(state, 'POST', '/api/local-calendar/events', { calendarId: 'local', title: 'Fictional planning', start: '2026-11-10T10:00:00Z', end: '2026-11-10T11:00:00Z', allDay: false });
  assert.equal(event.status, 201);
  assert.equal(call(state, 'GET', '/api/local-calendar/events?start=2026-11-10T00:00:00Z&end=2026-11-11T00:00:00Z').body.items.length, 1);
  assert.equal(call(state, 'GET', '/api/local-calendar/events?start=2026-01-01&end=2027-01-01').status, 400);
  assert.equal(call(state, 'DELETE', `/api/local-calendar/events/${event.body.id}?revision=stale`).status, 409);
  assert.equal(call(state, 'DELETE', `/api/local-calendar/events/${event.body.id}?revision=${event.body.revision}`).status, 200);
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.sent, []);
});

test('private note fixture follows conversation identity across moves and deletes without sending', () => {
  const state = createFixtureState();
  assert.equal(call(state, 'GET', '/api/private-notes/fixture-message-1').status, 403);
  call(state, 'PATCH', '/api/plugins/private-notes', { activated: true });
  const created = call(state, 'POST', '/api/private-notes/fixture-message-1', { text: '<b>Plain private note</b>', requestId: 'note-1', version: null });
  assert.equal(created.status, 201);
  assert.equal(call(state, 'POST', '/api/private-notes/fixture-message-1', { text: 'Stale', requestId: 'note-2', version: null }).status, 409);
  state.messages[0].folder = 'Archive';
  assert.equal(call(state, 'GET', '/api/private-notes/fixture-message-1').body.notes[0].text, '<b>Plain private note</b>');
  assert.equal(call(state, 'DELETE', '/api/private-notes/fixture-message-1/note-1', { version: created.body.version }).status, 200);
  assert.deepEqual(call(state, 'GET', '/api/private-notes/fixture-message-1').body.notes, []);
  assert.equal(call(state, 'POST', '/api/private-notes/fixture-message-1', { text: '<b>Plain private note</b>', requestId: 'note-1', version: null }).body.notes.length, 0);
  assert.deepEqual(state.sent, []);
});

test('fixture has only local built-in dependencies, no environment secrets or network forwarding', async () => {
  const source = await readFile(new URL('./superhuman-fixture-server.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(m => m[1]);
  assert.ok(imports.every(name => name.startsWith('node:')));
  assert.doesNotMatch(source, /process\.env|fetch\(|https?\.request\(|https?\.get\(|child_process|import\(.+backend/);
  assert.match(source, /server\.listen\(port, '127\.0\.0\.1'/);
});

test('HTTP boundary binds loopback, blocks cross-origin writes and escaping static files', async () => {
  const dist = await mkdtemp(path.join(os.tmpdir(), 'mailflow-fixture-'));
  await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>Fixture</title>');
  const outside = `${dist}-outside.txt`;
  await writeFile(outside, 'not served');
  await symlink(outside, path.join(dist, 'escape.txt'));
  const fixture = await createFixtureServer({ dist });
  const address = await fixture.listen(0);
  const request = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: address.port, path: url, method, headers }, res => {
      let raw = ''; res.on('data', data => { raw += data; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    assert.equal(address.address, '127.0.0.1');
    const html = await request('/');
    assert.equal(html.status, 200);
    assert.match(html.headers['content-security-policy'], /connect-src 'self'/);
    assert.equal(html.headers['x-mailflow-fixture'], 'fictional-local-only');
    assert.equal((await request('/api/accounts', { headers: { Host: 'production.example.com' } })).status, 403);
    assert.equal((await request('/api/auth/preferences', { method: 'PATCH', body: { theme: 'light' } })).status, 403);
    assert.equal((await request('/api/auth/preferences', { method: 'PATCH', headers: { 'X-Requested-With': 'MailFlow', Origin: 'https://outside.example' }, body: { theme: 'light' } })).status, 403);
    assert.equal((await request('/escape.txt')).status, 403);
    assert.equal((await request('/api/auth/preferences', { method: 'PATCH', headers: { 'X-Requested-With': 'MailFlow' }, body: { theme: 'superhuman' } })).status, 200);
    assert.equal(fixture.state.preferences.theme, 'superhuman');
  } finally { await new Promise(resolve => fixture.server.close(resolve)); await rm(dist, { recursive: true, force: true }); await rm(outside); }
});


test('muted fixture state persists independently and guards only the original inbox archive', () => {
  const state = createFixtureState();
  const id = state.messages[0].id;
  const path = `/api/mail/messages/${id}/mute`;
  const initial = call(state, 'GET', path).body;
  assert.equal(initial.muted, false);
  const saved = call(state, 'PATCH', path, { muted: true, revision: initial.revision }).body;
  assert.equal(saved.muted, true);
  assert.equal(state.messages[0].folder, 'INBOX');
  assert.equal(call(state, 'PATCH', path, { muted: false, revision: null }).status, 409);
  assert.equal(call(state, 'GET', '/api/mail/muted').body.messages.length, 1);
  const muteGuard = { messageId: id, accountId: state.messages[0].account_id, threadKey: saved.threadKey, revision: saved.revision };
  assert.equal(call(state, 'POST', '/api/mail/messages/bulk-archive', { ids: [state.messages[1].id], muteGuard }).status, 409);
  assert.deepEqual(call(state, 'POST', '/api/mail/messages/bulk-archive', { ids: [id], muteGuard }).body.archived, [id]);
  assert.equal(call(state, 'GET', '/api/mail/muted').body.messages[0].folder, 'Archive');
  call(state, 'PATCH', path, { muted: false, revision: saved.revision });
  assert.equal(call(state, 'GET', '/api/mail/muted').body.messages.length, 0);
  assert.equal(state.messages[0].folder, 'Archive');
  assert.equal(state.sent.length, 0);
});


test('resolve-message fixture supports current cached IDs and RFC IDs within account scope', () => {
  const state = createFixtureState(), message = state.messages[0];
  assert.equal(call(state, 'GET', `/api/mail/resolve-message?ref=${encodeURIComponent(message.id)}`).body.id, message.id);
  assert.equal(call(state, 'GET', `/api/mail/resolve-message?ref=${encodeURIComponent(message.message_id)}&accountId=${message.account_id}`).body.id, message.id);
  assert.equal(call(state, 'GET', `/api/mail/resolve-message?ref=${message.id}&accountId=fixture-personal`).status, 404);
  assert.equal(call(state, 'GET', '/api/mail/resolve-message?ref=missing').status, 404);
});
