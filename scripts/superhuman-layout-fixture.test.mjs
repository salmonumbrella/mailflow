import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFixtureState, createFixtureServer, handleFixtureApi, parseFixtureOptions } from './superhuman-layout-fixture.mjs';

const call = (state, method, url, body) => { const u = new URL(url, 'http://127.0.0.1'); return handleFixtureApi(state, method, u.pathname, u.searchParams, body); };

test('fresh instances contain only native baseline state and fictional identities', () => {
  const a = createFixtureState(), b = createFixtureState();
  assert.equal(a.preferences.layout, 'comfortable');
  assert.equal(a.preferences.theme, 'dark');
  assert.deepEqual(a.preferences.enabledPlugins, []);
  for (const key of ['snippets', 'mutedThreads', 'privateNotes', 'calendar', 'events']) assert.equal(key in a, false);
  for (const key of ['savedSplits', 'hideEmptySplits', 'savedSplitsRevision']) assert.equal(key in a.preferences, false);
  for (const account of a.accounts) assert.match(account.email_address, /\.example$/);
  for (const message of a.messages) {
    assert.match(message.from_email, /\.example$/);
    assert.match(message.message_id, /\.example>$/);
    for (const recipient of message.to_addresses) assert.match(recipient.email, /\.example$/);
  }
  a.messages[0].subject = 'Changed';
  assert.notEqual(a.messages[0].subject, b.messages[0].subject);
});

test('removed features and AI actions fail closed, baseline GTD stays inactive', () => {
  const state = createFixtureState();
  for (const url of ['/api/snippets', '/api/mail/muted', '/api/private-notes/fixture-message-1', '/api/local-calendar/catalog', '/api/open-activity', '/api/auth/preferences/saved-splits', '/api/search/splits']) {
    assert.equal(call(state, 'GET', url).status, 501);
    assert.equal(call(state, 'POST', url, {}).status, 501);
  }
  assert.equal(call(state, 'POST', '/api/ai/chat', {}).status, 501);
  assert.equal(call(state, 'POST', '/api/categories/ai-classify/fixture-message-1', {}).status, 501);
  assert.deepEqual(call(state, 'GET', '/api/plugins').body.map(p => [p.id,p.activated]), [['gtd',false]]);
  assert.equal(call(state, 'GET', '/api/ai/status').body.available, false);
});

test('native reader rows carry their fictional account accent in both GTD modes', () => {
  for (const gtd of [false, true]) {
    const state = createFixtureState({ gtd });
    const sections = call(state, 'GET', '/api/gtd/sections').body.sections;
    const rows = [...call(state, 'GET', '/api/mail/messages').body.messages,
      ...Object.values(sections).flatMap(section => section.threads || []),
      ...state.messages.map(m => call(state, 'GET', `/api/mail/messages/${m.id}`).body)];
    for (const message of rows) {
      const account = state.accounts.find(a => a.id === message.account_id);
      assert.equal(message.account_color, account.color, message.id);
      assert.equal(message.account_name, account.name, message.id);
    }
  }
});

test('native preferences opt in and revert without shared-instance side effects', () => {
  const state = createFixtureState();
  assert.equal(call(state, 'PATCH', '/api/auth/preferences', { layout: 'superhuman', theme: 'superhuman' }).status, 200);
  assert.equal(call(state, 'GET', '/api/auth/preferences').body.layout, 'superhuman');
  call(state, 'PATCH', '/api/auth/preferences', { layout: 'comfortable', theme: 'dark' });
  assert.equal(state.preferences.layout, 'comfortable');
  assert.equal(createFixtureState().preferences.layout, 'comfortable');
});

test('native captured triage and inverse move retain unrelated messages', () => {
  const state = createFixtureState(), ids = state.messages.slice(0, 2).map(m => m.id);
  assert.deepEqual(call(state, 'POST', '/api/mail/messages/bulk-archive', { ids }).body.archived, ids);
  assert.deepEqual(state.messages.slice(0,3).map(m => m.folder), ['Archive','Archive','INBOX']);
  assert.deepEqual(call(state, 'POST', '/api/mail/messages/bulk-move', { ids, folder: 'INBOX' }).body, { ok: true, moved: ids });
  call(state, 'POST', '/api/mail/messages/bulk-read', { ids, read: true });
  assert.ok(state.messages.slice(0,2).every(m => m.folder === 'INBOX' && m.is_read));
  assert.equal(state.mutations.length, 3);
});

test('ordinary folder copy preserves source and RFC identity without label capabilities', () => {
  const state=createFixtureState();
  const folder=call(state,'GET','/api/accounts/fixture-work/folders').body.find(f=>f.path==='Projects');
  assert.equal(folder.special_use,null);
  assert.equal(call(state,'POST','/api/mail/messages/fixture-message-1/copy',{folder:'Projects'}).status,200);
  assert.equal(state.messages[0].folder,'INBOX');
  assert.equal(state.messages.at(-1).folder,'Projects');
  assert.equal(state.messages.at(-1).message_id,state.messages[0].message_id);
});

test('native search subset, category and unread scopes use fictional rows', () => {
  const state=createFixtureState();
  assert.equal(call(state,'GET','/api/search?q=from%3Ajordan%20subject%3A%22quieter%20workspace%22').body.total,1);
  assert.equal(call(state,'GET','/api/mail/messages?accountId=fixture-personal').body.total,2);
  assert.equal(call(state,'GET','/api/mail/category-counts?accountId=fixture-work').body.totals.primary,4);
  assert.equal(call(state,'GET','/api/mail/unread-counts').body.total,5);
});

test('GTD opt-in supplies scoped sections, deduped Waiting and native header metadata', () => {
  const state = createFixtureState({ gtd: true, theme: 'light', layout: 'superhuman' });
  assert.deepEqual(state.preferences.enabledPlugins, ['gtd']);
  assert.equal(state.preferences.theme, 'light');
  assert.equal(state.preferences.layout, 'superhuman');
  assert.equal(call(state, 'GET', '/api/plugins').body[0].activated, true);
  assert.ok(state.accounts.every(a => a.gtd_enabled));
  const { sections } = call(state, 'GET', '/api/gtd/sections').body;
  for (const key of ['todo', 'watch', 'delegated', 'reference', 'someday']) {
    assert.ok(sections[key].total > 0, key);
    assert.equal(sections[key].unread, sections[key].threads.filter(m => !m.is_read).length);
    for (const thread of sections[key].threads) {
      assert.equal(call(state, 'GET', `/api/mail/messages/${thread.id}`).status, 200);
      assert.ok(thread.folders.includes(thread.folder));
      assert.equal(thread.in_inbox, true);
    }
  }
  assert.deepEqual(sections.waiting, { total: 2, unread: 1 });
  assert.equal(sections.watch.total + sections.delegated.total, 3);
  const personal = call(state, 'GET', '/api/gtd/sections?accountId=fixture-personal').body.sections;
  assert.equal(personal.todo.total, 0);
  assert.equal(personal.someday.total, 1);
  assert.ok(Object.values(personal).flatMap(s => s.threads || []).every(m => m.account_id === 'fixture-personal'));
  const metadata = call(state, 'POST', '/api/gtd/metadata', {
    accountId: 'fixture-work', messageIds: ['fixture-message-1', 'fixture-message-2', 'fixture-message-8'],
  }).body.messages;
  assert.deepEqual(metadata['fixture-message-1'].states, ['todo']);
  assert.deepEqual(metadata['fixture-message-2'].states, ['watch', 'delegated']);
  assert.ok(metadata['fixture-message-2'].dates.watch);
  assert.equal(metadata['fixture-message-8'], undefined);
  const labelHead = sections.todo.threads[0];
  assert.deepEqual(call(state, 'POST', '/api/gtd/metadata', { accountId: 'fixture-work', messageIds: [labelHead.id] }).body.messages[labelHead.id].states, ['todo']);
  assert.equal(call(state, 'GET', '/api/mail/unread-counts').body.total, 5);
  assert.equal(createFixtureState().messages.length, 9);
});

test('GTD config and activation gates do not leak metadata or mutate other instances', () => {
  const state = createFixtureState({ gtd: true });
  assert.equal(call(state, 'PUT', '/api/accounts/fixture-work', { gtd_enabled: false }).status, 200);
  assert.deepEqual(call(state, 'POST', '/api/gtd/metadata', { accountId: 'fixture-work', messageIds: ['fixture-message-1'] }).body, { messages: {} });
  assert.equal(call(state, 'GET', '/api/gtd/sections?accountId=fixture-work').body.sections.todo.total, 0);
  assert.equal(call(state, 'GET', '/api/gtd/sections').body.sections.someday.total, 1);
  assert.deepEqual(call(state, 'PATCH', '/api/plugins/gtd', { activated: false }).body, { id: 'gtd', activated: false });
  assert.equal(call(state, 'GET', '/api/gtd/sections').body.sections.someday.total, 0);
  assert.equal(state.accounts[1].gtd_enabled, true);
  assert.equal(call(state, 'PATCH', '/api/plugins/gtd', { activated: 'yes' }).status, 400);
  assert.equal(call(state, 'POST', '/api/gtd/metadata', { accountId: 'fixture-work', messageIds: [] }).status, 400);
  assert.equal(call(state, 'POST', '/api/gtd/metadata', { accountId: 'unknown', messageIds: ['fixture-message-1'] }).status, 404);
  assert.deepEqual(createFixtureState().preferences.enabledPlugins, []);
});

test('native image body starts blocked, reload is local and opt-in does not stick', () => {
  for (const gtd of [false, true]) {
    const state = createFixtureState({ gtd });
    const url = '/api/mail/messages/fixture-message-1/body';
    const blocked = call(state, 'GET', url).body;
    assert.equal(blocked.remoteImagesBlocked, true);
    assert.equal(blocked.hasBlockedRemoteImages, true);
    assert.equal(blocked.remoteImagesProxied, false);
    assert.doesNotMatch(blocked.html, /src="(?:https?:|\/fixture-resources\/)/);
    const loaded = call(state, 'GET', `${url}?remoteImages=1`).body;
    assert.equal(loaded.hasBlockedRemoteImages, false);
    assert.equal(loaded.remoteImagesBlocked, false);
    assert.equal(loaded.remoteImagesProxied, true);
    assert.match(loaded.html, /src="\/fixture-resources\/launch-preview\.svg"/);
    assert.equal(call(state, 'GET', url).body.hasBlockedRemoteImages, true);
    assert.equal(call(state, 'GET', `${url}?remoteImages=true`).body.hasBlockedRemoteImages, true);
    assert.equal(call(state, 'GET', '/api/mail/messages/fixture-message-2/body').body.hasBlockedRemoteImages, false);
    call(state, 'PATCH', '/api/auth/preferences', { imageWhitelist: { addresses: [state.messages[0].from_email], domains: [] } });
    assert.equal(call(state, 'GET', url).body.hasBlockedRemoteImages, false);
    call(state, 'PATCH', '/api/auth/preferences', { imageWhitelist: { addresses: [], domains: ['northstar.example'] } });
    assert.equal(call(state, 'GET', url).body.hasBlockedRemoteImages, false);
    call(state, 'PATCH', '/api/auth/preferences', { imageWhitelist: {}, blockRemoteImages: false });
    assert.equal(call(state, 'GET', url).body.hasBlockedRemoteImages, false);
  }
});

test('CLI preserves default mode and accepts explicit GTD, theme and layout options', () => {
  assert.deepEqual(parseFixtureOptions([]), { port: 4173, gtd: false, theme: 'dark', layout: 'comfortable' });
  assert.deepEqual(parseFixtureOptions(['--gtd', '--theme', 'catppuccin_latte', '--layout', 'superhuman', '--port', '0']),
    { port: 0, gtd: true, theme: 'catppuccin_latte', layout: 'superhuman' });
  assert.equal(parseFixtureOptions(['--gtd', 'off']).gtd, false);
  assert.equal(parseFixtureOptions(['--gtd', 'on']).gtd, true);
  for (const args of [['--port', 'abc'], ['--gtd', 'maybe'], ['--theme'], ['--provider', 'real']]) {
    assert.throws(() => parseFixtureOptions(args));
  }
});

test('draft capture never becomes delivery and all delivery routes reject', () => {
  const state=createFixtureState();
  assert.equal(call(state,'POST','/api/mail/draft',{accountId:'fixture-work',subject:'Fictional draft',body:'No send'}).status,200);
  for (const url of ['/api/mail/send','/api/mail/send/1/cancel','/api/mail/scheduled','/api/mail/scheduled/1/send-now']) assert.equal(call(state,'POST',url,{}).status,409);
  assert.equal(state.drafts.length,1);
  assert.equal(state.sent.length,4);
  assert.ok(state.sent.every(s=>s.delivered===false));
  assert.equal(call(state,'GET','/api/mail/scheduled').body.total,0);
});

test('fixture has only local built-in dependencies, no environment secrets or network forwarding', async () => {
  const source = await readFile(new URL('./superhuman-layout-fixture.mjs', import.meta.url), 'utf8');
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
    assert.equal(html.headers['x-mailflow-fixture'], 'native-layout-fictional-only');
    const blocked = JSON.parse((await request('/api/mail/messages/fixture-message-1/body')).raw);
    assert.equal(blocked.hasBlockedRemoteImages, true);
    const loaded = JSON.parse((await request('/api/mail/messages/fixture-message-1/body?remoteImages=1')).raw);
    const resourcePath = /src="(\/fixture-resources\/[^\"]+)"/.exec(loaded.html)?.[1];
    assert.ok(resourcePath, 'image reload must point to the built-in fixture resource');
    const image = await request(resourcePath);
    assert.equal(image.status, 200);
    assert.equal(image.headers['content-type'], 'image/svg+xml');
    assert.match(image.raw, /Fictional launch preview/);
    assert.doesNotMatch(image.raw.replace('xmlns="http://www.w3.org/2000/svg"', ''), /https?:|href=|<script/);
    assert.equal((await request(resourcePath, { method: 'POST' })).status, 405);
    assert.equal((await request('/api/accounts', { headers: { Host: 'production.example.com' } })).status, 403);
    assert.equal((await request('/api/auth/preferences', { method: 'PATCH', body: { theme: 'light' } })).status, 403);
    assert.equal((await request('/api/auth/preferences', { method: 'PATCH', headers: { 'X-Requested-With': 'MailFlow', Origin: 'https://outside.example' }, body: { theme: 'light' } })).status, 403);
    assert.equal((await request('/escape.txt')).status, 403);
    assert.equal((await request('/api/auth/preferences', { method: 'PATCH', headers: { 'X-Requested-With': 'MailFlow' }, body: { theme: 'superhuman' } })).status, 200);
    assert.equal(fixture.state.preferences.theme, 'superhuman');
  } finally { await new Promise(resolve => fixture.server.close(resolve)); await rm(dist, { recursive: true, force: true }); await rm(outside); }
});
