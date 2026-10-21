import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeMailflow, TOKENS, IDS, ALL_MAIL_ARCHIVE_ERROR } from '../test-support/fakeMailflow.js';
import { connect, untrustedPart, outsideUntrusted } from '../test-support/harness.js';
import { InFlight } from '../src/concurrency.js';

let fake;
let session;

test.before(async () => {
  fake = await startFakeMailflow();
  session = await connect({ fake, token: TOKENS.organize, scopes: ['read', 'organize'] });
});
test.after(async () => {
  await session.close();
  await fake.close();
});
test.beforeEach(() => {
  fake.reset();
});

const posts = path => fake.apiRequests().filter(entry => entry.method !== 'GET' && entry.path === path);

test('mark_read sends one bulk request and explains every id it did not change', async () => {
  const { text, isError } = await session.call('mark_read', { ids: [IDS.m1, IDS.m1.toUpperCase(), IDS.m2, IDS.missing], read: true });
  assert.equal(isError, undefined);
  const [request] = posts('/api/mail/messages/bulk-read');
  assert.deepEqual(request.body, { ids: [IDS.m1, IDS.m2, IDS.missing], read: true });
  assert.equal(request.headers['x-requested-with'], 'mailflow-mcp');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.headers.authorization, `Bearer ${TOKENS.organize}`);
  assert.match(text, /^Marked read: 1 of 3 messages changed\.\nChanged: id=b0000000-0000-4000-8000-000000000001\nNot changed:\n/);
  assert.match(text, new RegExp(`id=${IDS.m2} — already read`));
  assert.match(text, new RegExp(`id=${IDS.missing} — not found in MailFlow \\(it may have been moved or deleted; message ids change after a move or archive`));
});

test('mark_read is an error only when nothing happened for a reason other than "already so"', async () => {
  const already = await session.call('mark_read', { ids: [IDS.m2], read: true });
  assert.equal(already.isError, undefined);
  assert.match(already.text, /0 of 1 messages? changed[\s\S]*already read/);
  const gone = await session.call('mark_read', { ids: [IDS.missing], read: false });
  assert.equal(gone.isError, true);
  assert.match(gone.text, /Marked unread: 0 of 1 message changed/);
});

test('star stars and unstars', async () => {
  const { text } = await session.call('star', { ids: [IDS.m1], starred: true });
  assert.deepEqual(posts('/api/mail/messages/bulk-star')[0].body, { ids: [IDS.m1], starred: true });
  assert.match(text, /^Starred: 1 of 1 message changed\./);
  const again = await session.call('star', { ids: [IDS.m1], starred: true });
  assert.match(again.text, /already starred/);
  const off = await session.call('star', { ids: [IDS.m2], starred: false });
  assert.match(off.text, /already not starred/);
});

test('archive skips drafts, snoozed mail, Sent, Trash, archived and missing ids, and says why', async () => {
  const ids = [IDS.m1, IDS.draft, IDS.sent, IDS.trash, IDS.snoozed, IDS.archived, IDS.missing];
  const { text, isError } = await session.call('archive', { ids });
  assert.equal(isError, undefined);
  assert.equal(fake.apiRequests().filter(entry => entry.path === '/api/mail/resolve-message').length, 7, 'each row is loaded first');
  const [request] = posts('/api/mail/messages/bulk-archive');
  assert.deepEqual(request.body, { ids: [IDS.m1] });
  assert.match(text, /^Archived 1 of 7 messages\./);
  assert.match(text, new RegExp(`\\[1\\] was id=${IDS.m1} · account_id=${IDS.work} · from INBOX → the archive folder \\(most likely Archive\\)`));
  const skipped = {
    [IDS.draft]: 'a draft (this tool never moves or archives drafts)',
    [IDS.sent]: 'in Sent (Sent); pass includeNonInbox: true to include it',
    [IDS.trash]: 'in Trash (Trash); pass includeNonInbox: true to include it',
    [IDS.snoozed]: 'snoozed (unsnooze it first)',
    [IDS.archived]: 'already in the archive folder',
    [IDS.missing]: 'not found in MailFlow',
  };
  for (const [id, reason] of Object.entries(skipped)) assert.ok(text.includes(`id=${id} — ${reason}`), `${id}: ${reason}`);
  const inside = untrustedPart(text);
  assert.match(inside, /\[1\] From: Alice Example <alice@example.com> \| Subject: Lunch on Friday\? \| Message-ID: <m1@example.com>/);
  assert.ok(!outsideUntrusted(text).includes('<m1@example.com>'));
});

test("archive into Gmail's All Mail is MailFlow's refusal, passed on with what to do about it", async () => {
  const { text, isError } = await session.call('archive', { ids: [IDS.h1, IDS.m1] });
  assert.equal(isError, true);
  assert.deepEqual(posts('/api/mail/messages/bulk-archive')[0].body, { ids: [IDS.h1, IDS.m1] });
  assert.ok(text.includes(`The archive request failed: MailFlow refused this request: ${ALL_MAIL_ARCHIVE_ERROR}`), text);
});

test('archive on Gmail goes into a label named Archive once the account has one', async () => {
  const inbox = fake.users.pat.folders[IDS.home].find(entry => entry.path === 'INBOX');
  fake.users.pat.folders[IDS.home].push({ ...inbox, path: 'Archive', name: 'Archive', special_use: null });
  const { text, isError } = await session.call('archive', { ids: [IDS.h1] });
  assert.equal(isError, undefined);
  assert.match(text, new RegExp(`\\[1\\] was id=${IDS.h1} · account_id=${IDS.home} · from INBOX → the archive folder \\(most likely Archive\\)`));
});

test('archive with includeNonInbox takes Sent and Trash too, never drafts', async () => {
  await session.call('archive', { ids: [IDS.sent, IDS.trash, IDS.draft], includeNonInbox: true });
  assert.deepEqual(posts('/api/mail/messages/bulk-archive')[0].body, { ids: [IDS.sent, IDS.trash] });
});

test('archive names accounts without an archive folder', async () => {
  const { text, isError } = await session.call('archive', { ids: [IDS.s1] });
  assert.equal(isError, true);
  assert.match(text, new RegExp(`id=${IDS.s1} — its account \\(account_id=${IDS.shared}\\) has no archive folder MailFlow can find`));
});

test('archive with nothing left to do sends nothing and is an error', async () => {
  const { text, isError } = await session.call('archive', { ids: [IDS.draft, IDS.missing] });
  assert.equal(isError, true);
  assert.match(text, /^Archived 0 of 2 messages\./);
  assert.equal(posts('/api/mail/messages/bulk-archive').length, 0);
});

test("archive passes MailFlow's refusal through and still lists what it skipped", async () => {
  fake.override('POST', '/api/mail/messages/bulk-archive', (req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'API tokens cannot move or archive drafts' }));
  });
  const { text, isError } = await session.call('archive', { ids: [IDS.m1, IDS.missing] });
  assert.equal(isError, true);
  assert.match(text, /The archive request failed: MailFlow refused this request: API tokens cannot move or archive drafts/);
  assert.match(text, new RegExp(`id=${IDS.missing} — not found`));
});

test('a failed archive request that may have gone through says to check first', async () => {
  fake.override('POST', '/api/mail/messages/bulk-archive', (req, res) => {
    res.writeHead(502, { 'content-type': 'text/html' });
    res.end('<html>Bad gateway</html>');
  });
  const { text } = await session.call('archive', { ids: [IDS.m1] });
  assert.match(text, /MailFlow may still have completed this; check before retrying\. Check with search_mail or read_message by Message-ID before trying again\./);
  assert.equal(posts('/api/mail/messages/bulk-archive').length, 1, 'never retried');
});

test('archive and move skip what MailFlow counts as a draft: a Draft flag, or a Drafts folder mapped by hand', async () => {
  const rows = fake.users.pat.messages;
  const flagged = { ...rows.find(row => row.id === IDS.m2), id: 'b0000000-0000-4000-8000-0000000000d1', message_id: '<flagged@example.com>', thread_id: null, is_draft: true };
  const mapped = { ...rows.find(row => row.id === IDS.archived), id: 'b0000000-0000-4000-8000-0000000000d2', folder: 'Entwürfe', message_id: '<mapped@example.com>', is_draft: true };
  rows.push(flagged, mapped);
  fake.users.pat.folders[IDS.work].push({ ...fake.users.pat.folders[IDS.work].find(entry => entry.path === 'Projects'), path: 'Entwürfe', name: 'Entwürfe' });

  const archived = await session.call('archive', { ids: [IDS.m1, flagged.id] });
  assert.equal(archived.isError, undefined, archived.text);
  assert.deepEqual(posts('/api/mail/messages/bulk-archive')[0].body, { ids: [IDS.m1] });
  assert.ok(archived.text.includes(`id=${flagged.id} — a draft (this tool never moves or archives drafts)`), archived.text);
  // MailFlow's conversation listing is what says so; each conversation is asked once.
  assert.deepEqual(fake.apiRequests().filter(entry => entry.path === '/api/mail/thread').map(entry => entry.query.id).sort(), ['<m1@example.com>', flagged.id].sort());

  const moved = await session.call('move_messages', { ids: [IDS.m2, mapped.id], accountId: IDS.work, folder: 'Projects' });
  assert.equal(moved.isError, undefined, moved.text);
  assert.deepEqual(posts('/api/mail/messages/bulk-move')[0].body, { ids: [IDS.m2], folder: 'Projects' });
  assert.ok(moved.text.includes(`id=${mapped.id} — a draft`), moved.text);
});

test('a message whose draft status cannot be checked is left alone, with the reason', async () => {
  fake.override('GET', '/api/mail/thread', (req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to load thread' }));
  });
  const { text, isError } = await session.call('archive', { ids: [IDS.m1] });
  assert.equal(isError, true);
  assert.match(text, new RegExp(`id=${IDS.m1} — could not check whether it is a draft, so it was left alone: MailFlow answered 500 \\(MailFlow: "Failed to load thread"\\)`));
  assert.equal(posts('/api/mail/messages/bulk-archive').length, 0);
});

// A call the MCP client cancels while its lookups run, through the SDK as a host cancels it.
async function cancelDuring(name, args, slowPath) {
  const calls = new InFlight();
  const own = await connect({ fake, token: TOKENS.organize, scopes: ['read', 'organize'], calls });
  // Slow, then answered as usual.
  fake.override('GET', slowPath, async () => {
    await new Promise(resolve => setTimeout(resolve, 300));
    return false;
  });
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort('user pressed Esc'), 100);
    await assert.rejects(own.client.callTool({ name, arguments: args }, undefined, { signal: controller.signal }), /user pressed Esc/);
    // The handler has stopped by the time the call count is back to zero.
    await calls.idle();
  } finally {
    await own.close();
  }
}

test('a cancelled archive or move sends nothing after the cancel', async () => {
  const inbox = () => fake.users.pat.messages.filter(row => row.folder === 'INBOX').length;
  const before = inbox();
  await cancelDuring('archive', { ids: [IDS.m1, IDS.m2, IDS.h1] }, /^\/api\/accounts\/[^/]+\/folders$/);
  await cancelDuring('move_messages', { ids: [IDS.m1, IDS.m2], accountId: IDS.work, folder: 'Archive' }, '/api/mail/thread');
  assert.equal(posts('/api/mail/messages/bulk-archive').length, 0, 'no archive request');
  assert.equal(posts('/api/mail/messages/bulk-move').length, 0, 'no move request');
  assert.equal(inbox(), before);
});

test('a cancelled call stops its reads too, freeing the token\'s turns', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `f0000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`);
  const started = Date.now();
  await cancelDuring('archive', { ids }, '/api/mail/resolve-message');
  // Twelve lookups four at a time take three rounds of 300 ms; a cancelled call stops after the first.
  assert.ok(Date.now() - started < 700, `took ${Date.now() - started} ms`);
  assert.ok(fake.apiRequests().filter(entry => entry.path === '/api/mail/resolve-message').length <= 4);
});

test('rows are loaded at most four at a time', async () => {
  let active = 0;
  let peak = 0;
  fake.override('GET', '/api/mail/resolve-message', async (req, res) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active -= 1;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Message not found' }));
  });
  const ids = Array.from({ length: 12 }, (_, i) => `f0000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`);
  await session.call('archive', { ids });
  assert.equal(peak, 4);
});

test('move_messages moves within the given account and reports where each went', async () => {
  const ids = [IDS.m1, IDS.h1, IDS.draft, IDS.archived, IDS.missing];
  const { text, isError } = await session.call('move_messages', { ids, accountId: IDS.work, folder: 'Archive' });
  assert.equal(isError, undefined);
  assert.deepEqual(posts('/api/mail/messages/bulk-move')[0].body, { ids: [IDS.m1], folder: 'Archive' });
  assert.match(text, /^Moved 1 of 5 messages\.\nTheir ids have changed/);
  assert.match(text, new RegExp(`\\[1\\] was id=${IDS.m1} · account_id=${IDS.work} · from INBOX → Archive`));
  assert.ok(text.includes(`id=${IDS.h1} — it belongs to another account (account_id=${IDS.home}); MailFlow moves mail only within its own account`));
  assert.ok(text.includes(`id=${IDS.draft} — a draft`));
  assert.ok(text.includes(`id=${IDS.archived} — already in Archive`));
  assert.match(untrustedPart(text), /Message-ID: <m1@example.com>/);
  // The message has a new id in Archive, found again by its Message-ID.
  const found = await session.call('read_message', { messageId: '<m1@example.com>', accountId: IDS.work });
  assert.match(found.text, /Folder Archive/);
  assert.doesNotMatch(found.text, new RegExp(`id=${IDS.m1}`));
});

test('move_messages refuses a folder the account does not have, or one that holds no mail', async () => {
  const missing = await session.call('move_messages', { ids: [IDS.m1], accountId: IDS.work, folder: 'Nowhere' });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /has no folder "Nowhere"; nothing was moved/);
  const container = await session.call('move_messages', { ids: [IDS.m1], accountId: IDS.work, folder: '[Container]' });
  assert.match(container.text, /container that holds no mail; nothing was moved/);
  const disabled = await session.call('move_messages', { ids: [IDS.m1], accountId: IDS.old, folder: 'INBOX' });
  assert.match(disabled.text, /is disabled/);
  assert.equal(posts('/api/mail/messages/bulk-move').length, 0);
  assert.equal(fake.apiRequests().filter(entry => entry.path === '/api/mail/resolve-message').length, 0, 'no rows are loaded for a bad destination');
});

test("MailFlow's refusal of a protected destination comes through", async () => {
  const { text, isError } = await session.call('move_messages', { ids: [IDS.m1], accountId: IDS.work, folder: 'Trash' });
  assert.equal(isError, true);
  assert.match(text, /The move request failed: MailFlow refused this request: API tokens cannot move mail into Trash, Junk, Drafts, Snoozed or folders MailFlow does not sync/);
});

test('snooze needs a future time with an offset, within 30 days', async () => {
  const noOffset = await session.call('snooze', { id: IDS.m1, until: '2030-01-01T09:00:00' });
  assert.equal(noOffset.isError, true);
  assert.match(noOffset.text, /with a Z or an offset/);
  const past = await session.call('snooze', { id: IDS.m1, until: '2020-01-01T09:00:00Z' });
  assert.match(past.text, /must be in the future/);
  const far = new Date(Date.now() + 40 * 86400000).toISOString();
  assert.match((await session.call('snooze', { id: IDS.m1, until: far })).text, /at most 30 days/);
  assert.equal(posts(`/api/mail/messages/${IDS.m1}/snooze`).length, 0);
});

test('snooze moves the reply chain and says it comes back unread; snoozing again reschedules', async () => {
  const until = new Date(Date.now() + 2 * 86400000);
  until.setUTCMilliseconds(0);
  const local = `${until.toISOString().slice(0, 19)}+00:00`;
  const { text, isError } = await session.call('snooze', { id: IDS.m1, until: local });
  assert.equal(isError, undefined);
  assert.deepEqual(posts(`/api/mail/messages/${IDS.m1}/snooze`)[0].body, { until: until.toISOString() });
  assert.match(text, /and the rest of its reply chain in INBOX until .*come back to INBOX unread then\. The id stays the same/);
  const later = new Date(until.getTime() + 3600000).toISOString();
  const again = await session.call('snooze', { id: IDS.m1, until: later });
  const reschedule = fake.apiRequests().find(entry => entry.method === 'PATCH');
  assert.equal(reschedule.path, `/api/mail/messages/${IDS.m1}/snooze`);
  assert.match(again.text, /was already snoozed; it and the messages snoozed with it now come back at/);
});

test('unsnooze and set_category', async () => {
  const back = await session.call('unsnooze', { id: IDS.snoozed });
  assert.equal(posts(`/api/mail/messages/${IDS.snoozed}/unsnooze`).length, 1);
  assert.match(back.text, /Brought back 1 message snoozed with id=.* read state kept/);
  const notSnoozed = await session.call('unsnooze', { id: IDS.m1 });
  assert.equal(notSnoozed.isError, true);
  assert.equal(notSnoozed.text, `id=${IDS.m1} is not snoozed: it is in INBOX (account_id=${IDS.work}). list_messages with folder "Snoozed" shows snoozed mail.`);
  assert.doesNotMatch(notSnoozed.text, /moved|ids change/);
  const gone = await session.call('unsnooze', { id: IDS.missing });
  assert.match(gone.text, /Not found in MailFlow \(it may have been moved; message ids change/);
  const category = await session.call('set_category', { id: IDS.m1, category: 'newsletter' });
  const patch = fake.apiRequests().find(entry => entry.method === 'PATCH' && entry.path.endsWith('/category'));
  assert.deepEqual(patch.body, { category: 'newsletter' });
  assert.equal(patch.headers['x-requested-with'], 'mailflow-mcp');
  assert.match(category.text, /set to newsletter/);
  const wrong = await session.call('set_category', { id: IDS.m1, category: 'spam' });
  assert.equal(wrong.isError, true);
});
