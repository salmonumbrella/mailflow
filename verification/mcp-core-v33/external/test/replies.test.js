import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatAddress, parseRecipient, cleanName, isEmail, replySubject, buildReferences, replyInReplyTo,
  quoteBody, pickReplyAlias, buildReply, applyAutoRecipients, unexpectedBcc, formatRecipients,
  replyRecipientChecks, RecipientError, MAX_REFERENCES_LENGTH,
} from '../src/replies.js';

// What MailFlow's draft route accepts for In-Reply-To / References (routes/draft.js replyHeader).
const REFERENCES_HEADER = /^<[^<>\s]+>(?:[ \t]+<[^<>\s]+>)*$/;
// One address: a phrase with no specials, or a quoted string with no quote or backslash inside,
// then exactly one <address>; or a bare address.
const ONE_ADDRESS = /^(?:(?:"[^"\\\r\n]*"|[^",<>;:@()[\]\\\r\n"]+) <[^<>\s"\\]+>|[^\s<>",;:\\]+@[^\s<>",;:\\]+)$/;

const ACCOUNT = {
  id: 'acct',
  email_address: 'pat@work.example.com',
  aliases: [
    { id: 'alias-billing', name: 'Billing', email: 'billing@work.example.com' },
    { id: 'alias-sales', name: 'Sales', email: 'sales@work.example.com' },
  ],
  auto_cc_addresses: ['team@work.example.com', 'shared@work.example.com'],
  auto_bcc_addresses: ['records@work.example.com', 'Shared@work.example.com'],
};

test('display names that look like structure cannot add or change recipients', () => {
  const cases = [
    [{ name: 'Team: a@attacker.example;', email: 'carol@example.com' }, '"Team: a@attacker.example;" <carol@example.com>'],
    [{ name: 'Trailing\\', email: 'dave@example.com' }, 'Trailing <dave@example.com>'],
    [{ name: 'Evil, "Boss" <boss@attacker.example>\r\nBcc: leak@attacker.example', email: 'mallory@example.com' },
      '"Evil, Boss <boss@attacker.example> Bcc: leak@attacker.example" <mallory@example.com>'],
    [{ name: 'x" <a@attacker.example>, "y', email: 'erin@example.com' }, '"x <a@attacker.example>, y" <erin@example.com>'],
    [{ name: '(comment) Frank', email: 'frank@example.com' }, '"(comment) Frank" <frank@example.com>'],
    [{ name: 'José Müller', email: 'jose@example.com' }, 'José Müller <jose@example.com>'],
    [{ name: 'Right\u202eto left', email: 'rtl@example.com' }, 'Rightto left <rtl@example.com>'],
  ];
  for (const [entry, expected] of cases) {
    const formatted = formatAddress(entry);
    assert.equal(formatted, expected);
    assert.match(formatted, ONE_ADDRESS, formatted);
    assert.ok(!/[\r\n]/.test(formatted));
    assert.ok(formatted.endsWith(`<${entry.email}>`), 'the address itself is unchanged and last');
  }
});

test('a name that is empty or the address itself gives the bare address', () => {
  assert.equal(formatAddress({ name: '', email: 'a@example.com' }), 'a@example.com');
  assert.equal(formatAddress({ name: 'A@Example.com', email: 'a@example.com' }), 'a@example.com');
  assert.equal(formatAddress({ name: ' \r\n ', email: 'a@example.com' }), 'a@example.com');
  assert.equal(formatAddress({ email: 'a@example.com' }), 'a@example.com');
});

test('unusable addresses are refused rather than passed on', () => {
  for (const email of ['', 'not an address', 'a@b', 'a@@example.com', 'a,b@example.com', '<a@example.com>', 'a"b@example.com', 'a\\b@example.com', `${'x'.repeat(250)}@example.com`, undefined]) {
    assert.equal(formatAddress({ name: 'X', email }), null, String(email));
    assert.equal(isEmail(email), false, String(email));
  }
  assert.throws(() => formatRecipients([{ name: 'X', email: 'nope' }]), RecipientError);
});

test('cleanName strips line breaks, quotes, backslashes and invisible characters', () => {
  assert.equal(cleanName('a\r\nb"c\\d\u0000e\u200bf'), 'a b c def');
  assert.equal(cleanName(null), '');
  assert.equal(cleanName('x'.repeat(300)).length, 200);
});

test('typed recipients: one address each, no line breaks, at most one <…>', () => {
  assert.deepEqual(parseRecipient('alice@example.com'), { name: '', email: 'alice@example.com' });
  assert.deepEqual(parseRecipient(' Alice Example <alice@example.com> '), { name: 'Alice Example', email: 'alice@example.com' });
  assert.deepEqual(parseRecipient('"Doe, Jane" <jane@example.com>'), { name: 'Doe, Jane', email: 'jane@example.com' });
  assert.deepEqual(parseRecipient('<bare@example.com>'), { name: '', email: 'bare@example.com' });
  assert.equal(formatAddress(parseRecipient('"Doe, Jane" <jane@example.com>')), '"Doe, Jane" <jane@example.com>');
  const refused = [
    ['a@example.com, b@example.com', /not one email address/],
    ['Eve <eve@example.com> <mallory@example.com>', /more than one <…>/],
    ['Eve <eve@example.com>>', /more than one <…>/],
    ['x@example.com\r\nBcc: y@example.com', /line break/],
    ['Alice\n<alice@example.com>', /line break/],
    ['Alice <not an email>', /not one email address/],
    ['Alice alice@example.com', /not one email address/],
    ['<alice@example.com> trailing', /must look like/],
    ['   ', /empty recipient/],
  ];
  for (const [value, pattern] of refused) assert.throws(() => parseRecipient(value, 'to'), pattern, value);
  assert.throws(() => parseRecipient(42, 'cc'), /must be a string/);
});

test('reply subjects', () => {
  assert.equal(replySubject('Lunch'), 'Re: Lunch');
  assert.equal(replySubject('RE: Lunch'), 'RE: Lunch', 'a Re: in any case is kept');
  assert.equal(replySubject('re:Lunch'), 're:Lunch');
  assert.equal(replySubject('  Re: Lunch  '), 'Re: Lunch');
  assert.equal(replySubject('Aw: Lunch'), 'Re: Aw: Lunch');
  assert.equal(replySubject(''), 'Re:');
  assert.equal(replySubject(null), 'Re:');
  assert.equal(replySubject('a\r\nBcc: x@example.com'), 'Re: a Bcc: x@example.com');
});

test('References: the original\'s references, then its Message-ID, only <…> tokens, no repeats', () => {
  assert.equal(buildReferences({ thread_references: '<a@x> junk <b@x>', in_reply_to: '<b@x>', message_id: '<c@x>' }), '<a@x> <b@x> <c@x>');
  assert.equal(buildReferences({ thread_references: null, in_reply_to: '<p@x> (comment)', message_id: '<c@x>' }), '<p@x> <c@x>');
  assert.equal(buildReferences({ thread_references: '<a@x> <c@x>', message_id: '<c@x>' }), '<a@x> <c@x>');
  assert.equal(buildReferences({ thread_references: '<a@x>', message_id: 'no-brackets@x' }), '<a@x>');
  assert.equal(buildReferences({ message_id: null }), null);
  for (const value of ['<a@x> <b@x> <c@x>', '<p@x> <c@x>']) assert.match(value, REFERENCES_HEADER);
});

test('an over-long References keeps the root and the newest ids, within MailFlow\'s limit', () => {
  const ids = Array.from({ length: 300 }, (_, i) => `<${String(i).padStart(4, '0')}.${'x'.repeat(40)}@example.com>`);
  const value = buildReferences({ thread_references: ids.join(' '), message_id: '<newest@example.com>' });
  assert.ok(value.length <= MAX_REFERENCES_LENGTH, `${value.length}`);
  assert.match(value, REFERENCES_HEADER);
  assert.ok(value.startsWith(`${ids[0]} `));
  assert.ok(value.endsWith(` ${ids[299]} <newest@example.com>`));
});

test('In-Reply-To only for a well-formed Message-ID', () => {
  assert.equal(replyInReplyTo({ message_id: '<m1@example.com>' }), '<m1@example.com>');
  for (const value of ['m1@example.com', '<a b@example.com>', '<a><b>', '', null, `<${'x'.repeat(1000)}>`]) {
    assert.equal(replyInReplyTo({ message_id: value }), null, String(value));
  }
});

test('the quote: a header line, then every line prefixed with "> "', () => {
  const quote = quoteBody({ date: '2026-10-14T09:00:00Z', fromName: 'Alice Example', fromEmail: 'alice@example.com', text: 'Line one\r\n\r\nLine three\n' });
  assert.equal(quote, '\n\n---\nOn Wed, 14 Oct 2026 09:00:00 GMT, Alice Example <alice@example.com> wrote:\n> Line one\n> \n> Line three');
  assert.equal(quoteBody({ date: null, fromName: '', fromEmail: '', text: '   ' }), null);
  assert.match(quoteBody({ date: 'garbage', fromName: 'X', fromEmail: 'bad', text: 'hi' }), /On an unknown date, X wrote:/);
  const long = quoteBody({ date: null, fromName: '', fromEmail: 'a@example.com', text: 'word '.repeat(10000), maxChars: 1000 });
  assert.ok(long.length < 1200);
  assert.match(long, /\[quote shortened\]$/);
});

test('the quote is made in linear time from a body with a long run of spaces', () => {
  const started = Date.now();
  const quote = quoteBody({ date: null, fromName: '', fromEmail: 'a@example.com', text: `x${' '.repeat(120000)}y\n   \n`, maxChars: 200000 });
  assert.ok(quote.endsWith('y'));
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test('reply alias: delivery address first, then To/Cc, then From', () => {
  assert.equal(pickReplyAlias({ delivery_addresses: ['SALES@work.example.com'], to_addresses: [{ email: 'billing@work.example.com' }] }, ACCOUNT).id, 'alias-sales');
  assert.equal(pickReplyAlias({ delivery_addresses: ['pat@work.example.com'], cc_addresses: [{ email: 'Billing@Work.example.com' }] }, ACCOUNT).id, 'alias-billing');
  assert.equal(pickReplyAlias({ from_email: 'sales@work.example.com', to_addresses: [{ email: 'someone@example.com' }] }, ACCOUNT).id, 'alias-sales');
  assert.equal(pickReplyAlias({ to_addresses: [{ email: 'pat@work.example.com' }] }, ACCOUNT), null);
});

test('reply target: the first Reply-To with an address, else the sender', () => {
  const original = {
    from_name: 'Shop News',
    from_email: 'news@shop.example.com',
    reply_to: [{ name: 'Broken', email: '' }, { name: 'Shop Replies', email: 'replies@shop.example.com' }],
    subject: 'Order',
  };
  const checks = (orig, to, cc = []) => replyRecipientChecks({ original: orig, account: ACCOUNT, to, cc });
  const reply = buildReply({ original, account: ACCOUNT });
  assert.deepEqual(reply.to, [{ name: 'Shop Replies', email: 'replies@shop.example.com' }]);
  assert.deepEqual(checks(original, reply.to).replyTo, reply.to);
  const plain = buildReply({ original: { ...original, reply_to: [] }, account: ACCOUNT });
  assert.deepEqual(plain.to, [{ name: 'Shop News', email: 'news@shop.example.com' }]);
  assert.deepEqual(checks({ ...original, reply_to: [] }, plain.to).replyTo, []);
  const sameOriginal = { ...original, reply_to: [{ name: '', email: 'NEWS@shop.example.com' }] };
  const same = buildReply({ original: sameOriginal, account: ACCOUNT });
  assert.deepEqual(checks(sameOriginal, same.to).replyTo, [], 'a Reply-To equal to the sender is not flagged');
});

test('the final recipients are checked however they were chosen', () => {
  const original = {
    from_email: 'news@shop.example.com',
    reply_to: [{ name: 'Shop Replies', email: 'replies@shop.example.com' }],
    to_addresses: [{ email: 'pat@work.example.com' }],
    cc_addresses: [{ email: 'bob@example.com' }],
  };
  const check = (to, cc = []) => replyRecipientChecks({ original, account: ACCOUNT, to, cc });
  // Given explicitly, the Reply-To is still the Reply-To.
  assert.deepEqual(check([{ name: '', email: 'REPLIES@shop.example.com' }]).replyTo.map(entry => entry.email), ['REPLIES@shop.example.com']);
  const leak = check([{ name: '', email: 'leak@attacker.example' }], [{ name: '', email: 'bob@example.com' }, { name: '', email: 'team@work.example.com' }]);
  assert.deepEqual(leak.notOnOriginal.map(entry => entry.email), ['leak@attacker.example'], 'the original\'s people and the automatic Cc are expected');
  assert.deepEqual(leak.replyTo, []);
  assert.deepEqual(check([{ name: '', email: 'news@shop.example.com' }]).notOnOriginal, []);
  assert.deepEqual(check([{ name: '', email: 'Sales@work.example.com' }]).own.map(entry => entry.email), ['Sales@work.example.com']);
  assert.equal(check([{ name: '', email: 'x@example.com' }, { name: 'X', email: 'X@example.com' }]).notOnOriginal.length, 1, 'counted once');
});

test('reply all: original To and Cc, minus own addresses and the target, all without case', () => {
  const original = {
    from_name: 'Alice',
    from_email: 'Alice@Example.com',
    to_addresses: [{ name: 'Pat', email: 'PAT@work.example.com' }, { name: 'Bob', email: 'bob@example.com' }],
    cc_addresses: [
      { name: 'Alice again', email: 'alice@example.com' },
      { name: 'Sales', email: 'Sales@Work.Example.com' },
      { name: 'Bob twice', email: 'BOB@example.com' },
      { name: 'Carol', email: 'carol@example.com' },
      { name: 'Broken', email: 'not an address' },
    ],
    subject: 'Plans',
    message_id: '<plans@example.com>',
  };
  const reply = buildReply({ original, account: ACCOUNT, replyAll: true });
  assert.deepEqual(reply.to, [{ name: 'Alice', email: 'Alice@Example.com' }]);
  assert.deepEqual(reply.cc, [{ name: 'Bob', email: 'bob@example.com' }, { name: 'Carol', email: 'carol@example.com' }]);
  assert.deepEqual(reply.skipped, ['not an address']);
  assert.equal(reply.subject, 'Re: Plans');
  assert.equal(reply.inReplyTo, '<plans@example.com>');
  assert.equal(reply.references, '<plans@example.com>');
  assert.deepEqual(buildReply({ original, account: ACCOUNT }).cc, [], 'a plain reply has no Cc');
});

test('explicit to, cc and subject replace the computed ones', () => {
  const original = { from_email: 'alice@example.com', to_addresses: [{ email: 'bob@example.com' }], subject: 'Plans' };
  const reply = buildReply({
    original,
    account: ACCOUNT,
    replyAll: true,
    overrides: { to: [{ name: '', email: 'zed@example.com' }], cc: [], subject: 'New subject' },
  });
  assert.deepEqual(reply.to, [{ name: '', email: 'zed@example.com' }]);
  assert.deepEqual(reply.cc, []);
  assert.equal(reply.subject, 'New subject');
  assert.deepEqual(replyRecipientChecks({ original, account: ACCOUNT, to: reply.to, cc: reply.cc }).notOnOriginal, reply.to);
});

test('a reply to the user\'s own message is flagged', () => {
  const original = { from_email: 'pat@work.example.com', subject: 'x' };
  const reply = buildReply({ original, account: ACCOUNT });
  assert.deepEqual(replyRecipientChecks({ original, account: ACCOUNT, to: reply.to, cc: [] }).own, reply.to);
});

test('the quote comes only when asked for and when there is text', () => {
  const original = { from_name: 'Alice', from_email: 'alice@example.com', date: '2026-10-14T09:00:00Z' };
  assert.match(buildReply({ original, account: ACCOUNT, quoteText: 'Hi there' }).quotedBody, /wrote:\n> Hi there$/);
  assert.equal(buildReply({ original, account: ACCOUNT, quoteText: 'Hi there', includeQuote: false }).quotedBody, null);
  assert.equal(buildReply({ original, account: ACCOUNT, quoteText: null }).quotedBody, null);
});

test('automatic Cc and Bcc are added once, never twice, and an address on both goes to Cc', () => {
  const result = applyAutoRecipients({
    to: [{ name: 'Team', email: 'TEAM@work.example.com' }],
    cc: [],
    bcc: [{ name: '', email: 'hidden@example.com' }],
  }, ACCOUNT);
  assert.deepEqual(result.cc.map(entry => entry.email), ['shared@work.example.com']);
  assert.deepEqual(result.bcc.map(entry => entry.email), ['hidden@example.com', 'records@work.example.com']);
  assert.deepEqual(result.added, { cc: ['shared@work.example.com'], bcc: ['records@work.example.com'] });
  assert.deepEqual(unexpectedBcc(result.bcc, ACCOUNT).map(entry => entry.email), ['hidden@example.com']);
  const none = applyAutoRecipients({ to: [], cc: [], bcc: [] }, { auto_cc_addresses: null });
  assert.deepEqual(none.added, { cc: [], bcc: [] });
});
