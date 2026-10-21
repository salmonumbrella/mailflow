import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeMailflow, TOKENS, IDS } from '../test-support/fakeMailflow.js';
import { connect, untrustedPart, outsideUntrusted } from '../test-support/harness.js';
import { InFlight } from '../src/concurrency.js';

// One address: a phrase without specials or a quoted string without quotes inside, then <address>; or a bare address.
const ONE_ADDRESS = /^(?:(?:"[^"\\\r\n]*"|[^",<>;:@()[\]\\\r\n"]+) <[^<>\s"\\]+>|[^\s<>",;:\\]+@[^\s<>",;:\\]+)$/;

let fake;
let session;

test.before(async () => {
  fake = await startFakeMailflow();
  session = await connect({ fake, token: TOKENS.all, scopes: ['read', 'organize', 'draft'] });
});
test.after(async () => {
  await session.close();
  await fake.close();
});
test.beforeEach(() => {
  fake.reset();
});

const saved = () => fake.state.savedDrafts;
const draftPosts = () => fake.apiRequests().filter(entry => entry.method === 'POST' && entry.path === '/api/mail/draft');

test('a new message: plain text, create-only, with the account\'s automatic Cc and Bcc', async () => {
  const { text, isError } = await session.call('create_draft', {
    accountId: IDS.work,
    to: ['Alice Example <alice@example.com>', 'bob@example.com'],
    subject: 'Agenda',
    body: 'Hello\nHere is the agenda.',
  });
  assert.equal(isError, undefined);
  const [request] = draftPosts();
  assert.equal(request.headers['x-requested-with'], 'mailflow-mcp');
  assert.deepEqual(request.body, {
    accountId: IDS.work,
    to: ['Alice Example <alice@example.com>', 'bob@example.com'],
    cc: ['team@work.example.com'],
    bcc: ['records@work.example.com'],
    subject: 'Agenda',
    body: 'Hello\nHere is the agenda.',
    bodyIsHtml: false,
    includeIdentity: true,
  });
  for (const field of ['existingUid', 'existingFolder', 'existingAccountId', 'quotedBodyHtml', 'editedSignature']) assert.ok(!(field in request.body), field);
  assert.match(text, /^Draft saved to Drafts in Work <pat@work.example.com>\. Review and send it from MailFlow\.\nuid=100 folder=Drafts messageId=<0+1@work.example.com> account_id=/);
  assert.match(text, /Added the account's automatic recipients: Cc team@work.example.com; Bcc records@work.example.com\./);
  assert.doesNotMatch(text, /Check before sending/);
  const inside = untrustedPart(text);
  assert.match(inside, /To: Alice Example <alice@example.com>, bob@example.com\nCc: team@work.example.com\nBcc: records@work.example.com\nSubject: Agenda/);
});

test('the signature is left off when the account has it off by default', async () => {
  await session.call('create_draft', { accountId: IDS.home, to: ['dana@example.com'], subject: 'Hi', body: 'x' });
  assert.equal(saved()[0].editedSignature, '');
});

test('bad recipients are refused before anything is sent', async () => {
  for (const to of [['a@example.com, b@example.com'], ['Eve <e@example.com> <m@example.com>'], ['x@example.com\r\nBcc: y@example.com']]) {
    const result = await session.call('create_draft', { accountId: IDS.work, to, body: 'x' });
    assert.equal(result.isError, true, to[0]);
  }
  assert.equal(fake.apiRequests().length, 0);
  const missingAccount = await session.call('create_draft', { to: ['a@example.com'], body: 'x' });
  assert.match(missingAccount.text, /accountId is required for a new message/);
});

test('a reply: recipients, alias, subject, threading headers and quote come from the original', async () => {
  const { text, isError } = await session.call('create_draft', { replyToId: IDS.m1, body: 'Friday works for me.' });
  assert.equal(isError, undefined);
  const sequence = fake.apiRequests().map(entry => `${entry.method} ${entry.path}`);
  assert.deepEqual(sequence, [
    'GET /api/accounts',
    `GET /api/mail/messages/${IDS.m1}`,
    'POST /api/mail/reply-drafts/indicators',
    `GET /api/mail/messages/${IDS.m1}/body`,
    'POST /api/mail/draft',
  ]);
  assert.deepEqual(fake.apiRequests()[2].body, { ids: [IDS.m1], accountId: IDS.work });
  const draft = saved()[0];
  assert.equal(draft.accountId, IDS.work);
  assert.equal(draft.aliasId, IDS.sales, 'the alias it was delivered to');
  assert.deepEqual(draft.to, ['Alice Example <alice@example.com>']);
  assert.deepEqual(draft.cc, ['team@work.example.com']);
  assert.deepEqual(draft.bcc, ['records@work.example.com']);
  assert.equal(draft.subject, 'Re: Lunch on Friday?');
  assert.equal(draft.inReplyTo, '<m1@example.com>');
  assert.equal(draft.references, '<m1@example.com>');
  assert.equal(draft.body, 'Friday works for me.');
  assert.equal(draft.quotedBody, '\n\n---\nOn Wed, 14 Oct 2026 09:00:00 GMT, Alice Example <alice@example.com> wrote:\n> Are you free on Friday?\n> Let me know.');
  assert.equal(draft.bodyIsHtml, false);
  assert.match(text, new RegExp(`It replies to id=${IDS.m1}, with In-Reply-To and References set; no earlier reply draft was found\\.`));
  assert.match(text, /alias_id=a1a1a1a1-0000-4000-8000-000000000001/);
  assert.match(untrustedPart(text), /Original sender: Alice Example <alice@example.com>/);
});

test('reply all leaves out the user\'s own addresses and the reply target, ignoring case', async () => {
  await session.call('create_draft', { replyToId: IDS.m1, replyAll: true, body: 'x' });
  assert.deepEqual(saved()[0].cc, ['Bob <bob@example.com>', 'team@work.example.com']);
});

test('a reply to a Reply-To that is not the sender is flagged, and HTML-only mail is quoted as text', async () => {
  const { text } = await session.call('create_draft', { replyToId: IDS.m2, body: 'Thanks' });
  const draft = saved()[0];
  assert.deepEqual(draft.to, ['Shop Replies <replies@shop.example.com>']);
  assert.equal(draft.subject, 'RE: Your order');
  assert.equal(draft.references, '<m0@shop.example.com> <m1x@shop.example.com> <m2@shop.example.com>');
  assert.match(draft.quotedBody, /wrote:\n> Your order has & shipped…\n> \n> Track it here \(https:\/\/shop.example.com\/track\?id=1&x=2\)\./);
  assert.match(outsideUntrusted(text), /Check before sending: the reply goes to the original's Reply-To address, which is not its sender/);
  assert.match(untrustedPart(text), /Original Reply-To: Shop Replies <replies@shop.example.com>/);
});

test('a reply is checked in the recipients it ends up with, given or computed', async () => {
  // The Reply-To typed in explicitly is still a Reply-To that is not the sender.
  const explicit = await session.call('create_draft', { replyToId: IDS.m2, to: ['Shop Replies <replies@shop.example.com>'], body: 'Thanks' });
  assert.deepEqual(saved()[0].to, ['Shop Replies <replies@shop.example.com>']);
  assert.match(outsideUntrusted(explicit.text), /Check before sending: the reply goes to the original's Reply-To address, which is not its sender/);
  // An address that was nowhere on the original, as an email asking for "the details to X" would want.
  const leak = await session.call('create_draft', { replyToId: IDS.m2, to: ['leak@attacker.example'], cc: ['bob@example.com'], body: 'Here are the details' });
  assert.ok(saved()[1].quotedBody, 'the original is quoted');
  const outside = outsideUntrusted(leak.text);
  assert.match(outside, /Check before sending: 2 recipients were not on the original message at all \(listed below\)\./);
  assert.ok(!outside.includes('leak@attacker.example'), 'the address itself stays inside the block');
  assert.match(untrustedPart(leak.text), /Not on the original: leak@attacker.example, bob@example.com/);
  // The original's own people and the account's automatic Cc are expected.
  const usual = await session.call('create_draft', { replyToId: IDS.m1, replyAll: true, body: 'x' });
  assert.doesNotMatch(usual.text, /not on the original/);
});

test('a cancelled draft is not saved', async () => {
  const calls = new InFlight();
  const own = await connect({ fake, token: TOKENS.all, scopes: ['read', 'organize', 'draft'], calls });
  fake.override('GET', `/api/mail/messages/${IDS.m1}/body`, async () => {
    await new Promise(resolve => setTimeout(resolve, 300));
    return false;
  });
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort('user pressed Esc'), 100);
    await assert.rejects(own.client.callTool({ name: 'create_draft', arguments: { replyToId: IDS.m1, body: 'x' } }, undefined, { signal: controller.signal }), /user pressed Esc/);
    await calls.idle();
  } finally {
    await own.close();
  }
  assert.equal(draftPosts().length, 0);
});

test('injection-shaped display names never become extra recipients', async () => {
  const { text } = await session.call('create_draft', { replyToId: IDS.m3, replyAll: true, body: 'Noted.' });
  const draft = saved()[0];
  assert.deepEqual(draft.to, ['"Evil, Boss <boss@attacker.example> Bcc: leak@attacker.example" <mallory@example.com>']);
  assert.deepEqual(draft.cc, ['"Team: a@attacker.example;" <carol@example.com>', 'Trailing <dave@example.com>', 'team@work.example.com']);
  for (const value of [...draft.to, ...draft.cc, ...draft.bcc]) {
    assert.match(value, ONE_ADDRESS, value);
    assert.ok(!/[\r\n]/.test(value));
  }
  const addresses = [...draft.to, ...draft.cc, ...draft.bcc].map(value => (/<([^<>]+)>$/.exec(value) || [null, value])[1]);
  for (const planted of ['leak@attacker.example', 'boss@attacker.example', 'a@attacker.example']) assert.ok(!addresses.includes(planted), planted);
  assert.match(text, /Check before sending: 1 of the original's recipients had addresses MailFlow could not use and were left out\./);
});

test('an existing reply draft stops a second one unless allowed', async () => {
  fake.state.replyDrafts[IDS.m1] = { exists: true, accountId: IDS.work };
  const refused = await session.call('create_draft', { replyToId: IDS.m1, body: 'x' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /^No draft was saved\. A reply draft to this conversation already exists in Drafts\. Edit that draft in MailFlow, or call create_draft again with allowDuplicateReply: true/);
  assert.equal(draftPosts().length, 0);
  const allowed = await session.call('create_draft', { replyToId: IDS.m1, body: 'x', allowDuplicateReply: true });
  assert.equal(allowed.isError, undefined);
  assert.match(allowed.text, /saved although a reply draft already existed \(allowDuplicateReply\)/);
});

test('a reply that cannot be checked for an existing draft is refused unless allowed', async () => {
  const unknown = async () => {
    const result = await session.call('create_draft', { replyToId: IDS.m1, body: 'x' });
    assert.equal(result.isError, true);
    assert.equal(draftPosts().length, 0);
    return result.text;
  };
  fake.state.replyDrafts[IDS.m1] = { unknown: true };
  assert.match(await unknown(), /Could not confirm that no reply draft exists yet \(the conversation is too large for MailFlow to check\)\. Check Drafts in MailFlow/);
  fake.state.replyDrafts = {};
  fake.state.indicatorOmits.add(IDS.m1);
  assert.match(await unknown(), /\(MailFlow did not report on this message\)/);
  fake.state.indicatorOmits.clear();
  fake.override('POST', '/api/mail/reply-drafts/indicators', (req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Could not check reply drafts' }));
  });
  assert.match(await unknown(), /\(MailFlow answered 503 \(MailFlow: "Could not check reply drafts"\)\.\)/);
  const allowed = await session.call('create_draft', { replyToId: IDS.m1, body: 'x', allowDuplicateReply: true });
  assert.equal(allowed.isError, undefined);
  assert.match(allowed.text, /saved without confirming that no reply draft existed/);
});

test('a reply to mail outside INBOX skips the reply-draft check, which only covers INBOX', async () => {
  const { text, isError } = await session.call('create_draft', { replyToId: IDS.sent, body: 'x' });
  assert.equal(isError, undefined);
  assert.equal(fake.apiRequests().filter(entry => entry.path === '/api/mail/reply-drafts/indicators').length, 0);
  // As in the web composer, a reply goes to the sender, here the user; the result says so.
  assert.deepEqual(saved()[0].to, ['Pat Example <pat@work.example.com>']);
  assert.match(text, /Check before sending: the reply goes to one of the user's own addresses\./);
});

test('replyToMessageId resolves the original in the given account', async () => {
  const { isError } = await session.call('create_draft', { replyToMessageId: 'h1@example.com', accountId: IDS.home, body: 'x' });
  assert.equal(isError, undefined);
  assert.deepEqual(fake.apiRequests().find(entry => entry.path === '/api/mail/resolve-message').query, { ref: '<h1@example.com>', accountId: IDS.home });
  assert.equal(saved()[0].accountId, IDS.home);
  assert.equal(saved()[0].editedSignature, '');
  const noAccount = await session.call('create_draft', { replyToMessageId: '<h1@example.com>', body: 'x' });
  assert.match(noAccount.text, /accountId is required with replyToMessageId/);
  const both = await session.call('create_draft', { replyToId: IDS.m1, replyToMessageId: '<m1@example.com>', accountId: IDS.work, body: 'x' });
  assert.match(both.text, /replyToId or replyToMessageId, not both/);
});

test('a reply stays in the original\'s account and alias ids must belong to it', async () => {
  const other = await session.call('create_draft', { replyToId: IDS.m1, accountId: IDS.home, body: 'x' });
  assert.equal(other.isError, true);
  assert.match(other.text, /a reply is drafted in the same account, so accountId .* was refused/);
  const alias = await session.call('create_draft', { accountId: IDS.home, aliasId: IDS.sales, to: ['a@example.com'], body: 'x' });
  assert.equal(alias.isError, true);
  assert.match(alias.text, /is not an alias of Home/);
  assert.equal(draftPosts().length, 0);
});

test('explicit to, cc and subject replace the computed ones; extra Bcc is flagged', async () => {
  const { text } = await session.call('create_draft', {
    replyToId: IDS.m1,
    replyAll: true,
    to: ['Zed <zed@example.com>'],
    cc: [],
    bcc: ['hidden@example.com'],
    subject: 'Different subject',
    body: 'x',
  });
  const draft = saved()[0];
  assert.deepEqual(draft.to, ['Zed <zed@example.com>']);
  assert.deepEqual(draft.cc, ['team@work.example.com']);
  assert.deepEqual(draft.bcc, ['hidden@example.com', 'records@work.example.com']);
  assert.equal(draft.subject, 'Different subject');
  assert.equal(draft.inReplyTo, '<m1@example.com>', 'still threaded');
  assert.match(text, /Check before sending: Bcc has 1 address that is not this account's automatic Bcc\./);
  assert.match(untrustedPart(text), /Bcc not added automatically: hidden@example.com/);
});

test('without a quote no body is fetched; a quote that cannot load stops the draft', async () => {
  await session.call('create_draft', { replyToId: IDS.m1, includeQuote: false, body: 'x' });
  assert.equal(fake.apiRequests().filter(entry => entry.path.endsWith('/body')).length, 0);
  assert.ok(!('quotedBody' in saved()[0]));
  fake.override('GET', `/api/mail/messages/${IDS.m1}/body`, (req, res) => {
    res.writeHead(504, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'This message is taking too long to load', timeout: true }));
  });
  const failed = await session.call('create_draft', { replyToId: IDS.m1, body: 'x', allowDuplicateReply: true });
  assert.equal(failed.isError, true);
  assert.match(failed.text, /No draft was saved: the original's text for the quote did not load .* set includeQuote: false/);
  assert.equal(draftPosts().length, 1, 'only the earlier draft');
});

test('a draft request that may have gone through says to look in Drafts first', async () => {
  fake.override('POST', '/api/mail/draft', (req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Command failed' }));
  });
  const { text, isError } = await session.call('create_draft', { accountId: IDS.work, to: ['a@example.com'], body: 'x' });
  assert.equal(isError, true);
  assert.match(text, /MailFlow may still have completed this; check before retrying\. The draft may have been saved anyway: look in Drafts in MailFlow before trying again/);
  assert.equal(draftPosts().length, 1, 'never retried');
});

test('MailFlow refusing a draft passes its reason through', async () => {
  fake.override('POST', '/api/mail/draft', (req, res) => {
    res.writeHead(422, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'No Drafts folder found for this account' }));
  });
  const { text } = await session.call('create_draft', { accountId: IDS.work, to: ['a@example.com'], body: 'x' });
  assert.match(text, /^MailFlow: No Drafts folder found for this account$/);
});
