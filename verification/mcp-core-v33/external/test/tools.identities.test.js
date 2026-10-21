import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeMailflow, TOKENS, IDS } from '../test-support/fakeMailflow.js';
import { connect } from '../test-support/harness.js';

// Existing fake HTTP overrides exercise the real SDK/client path, not real PAT authorization.
const requestId = 'abcdefab-1111-4111-8111-111111111111';
const secret = 'synthetic-provider-secret';
const input = { accountId: IDS.work, confirmed: true, clientRequestId: requestId };
const inventory = (overrides = {}) => ({ accountId: IDS.work, provider: 'fastmail', identityStatus: 'ready',
  maskedStatus: 'ready', reason: null, identities: [], maskedEmails: [], configRevision: null,
  checkedAt: '2026-10-21T00:00:00.000Z', ...overrides });
const send = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

async function fixture(scopes) {
  const fake = await startFakeMailflow();
  const session = await connect({ fake, token: TOKENS.read, scopes });
  return { fake, session, async close() { await session.close(); await fake.close(); } };
}

test('tool discovery grants identity reads and writes independently', async () => {
  for (const [extra, expected] of [[[], []], [['identity:read'], ['list_fastmail_masked_aliases', 'list_gmail_send_as']],
    [['identity:write'], ['create_fastmail_masked_alias']]]) {
    const f = await fixture(['read', ...extra]);
    try {
      const { tools } = await f.session.client.listTools();
      assert.deepEqual(tools.map(t => t.name).filter(n => /masked|send_as/.test(n)).sort(), expected.sort());
      if (extra.includes('identity:write')) assert.deepEqual(tools.find(t => t.name === 'create_fastmail_masked_alias').annotations,
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    } finally { await f.close(); }
  }
});

test('create requires explicit confirmation and rejects credentials, description markers and invalid origins before API access', async () => {
  const f = await fixture(['read', 'identity:write']);
  try {
    for (const args of [{ ...input, confirmed: false }, { ...input, token: secret },
      { ...input, description: '[mailflow:forged]' }, { ...input, forDomain: 'https://synthetic.test/path' },
      { ...input, forDomain: 'https://SHOP.synthetic.test' },
      { ...input, forDomain: 'https://shop.synthetic.test:443' }, { ...input, emailPrefix: 'Uppercase' }, { ...input, emailPrefix: 'a\n' },
      { ...input, clientRequestId: `${requestId}\n` }]) {
      const result = await f.session.call('create_fastmail_masked_alias', args);
      assert.equal(result.isError, true);
    }
    assert.equal(f.fake.apiRequests().length, 0);
  } finally { await f.close(); }
});

test('masked create projects only allowlisted fields and sends one account-bound write with canonical request id', async () => {
  const f = await fixture(['read', 'identity:write']);
  try {
    f.fake.override('POST', `/api/accounts/${IDS.work}/masked-emails`, (_req, res) => send(res,
      { accountId: IDS.work, provider: 'fastmail', email: 'mask@synthetic.test', state: 'enabled',
        outcome: 'created', clientRequestId: requestId, token: secret, description: secret }));
    const result = await f.session.call('create_fastmail_masked_alias', { ...input, clientRequestId: requestId.toUpperCase() });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.clientRequestId, requestId);
    assert.equal(result.structuredContent.state, 'enabled');
    assert.equal(JSON.stringify(result).includes(secret), false);
    const [request] = f.fake.apiRequests();
    assert.equal(request.path, `/api/accounts/${IDS.work}/masked-emails`);
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, `Bearer ${TOKENS.read}`);
    assert.equal(request.headers['x-requested-with'], 'mailflow-mcp');
    assert.equal(request.body.clientRequestId, requestId);
    assert.equal(f.fake.apiRequests().length, 1);
  } finally { await f.close(); }
});

test('an uncertain write keeps a write-only identity grant unknown and performs no list or retry', async () => {
  const f = await fixture(['read', 'identity:write']);
  try {
    f.fake.override('POST', `/api/accounts/${IDS.work}/masked-emails`, (_req, res) => send(res,
      { reason: 'outcome_unknown', outcome: 'unknown', error: secret }, 503));
    const result = await f.session.call('create_fastmail_masked_alias', input);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.reason, 'outcome_unknown');
    assert.equal(result.structuredContent.mayHaveCompleted, true);
    assert.match(result.text, /This token cannot list/);
    assert.equal(/broader|new token|obtain.*scope/i.test(result.text), false);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(f.fake.apiRequests().length, 1);
  } finally { await f.close(); }
});

test('Gmail list returns accepted inventory, and unavailable or cross-account inventory is an error', async () => {
  const f = await fixture(['read', 'identity:read']);
  try {
    const path = `/api/accounts/${IDS.work}/sender-identities`;
    for (const [body, reason] of [[inventory({ provider: 'gmail', maskedStatus: 'unsupported', identities: [{ email: 'primary@synthetic.test', token: secret }] }), null],
      [inventory({ provider: 'gmail', identityStatus: 'unknown', reason: 'api_not_enabled' }), 'api_not_enabled'],
      [inventory({ accountId: IDS.home, provider: 'gmail' }), 'invalid_response'],
      [inventory(), 'unsupported_provider']]) {
      f.fake.override('GET', path, (_req, res) => send(res, body));
      const result = await f.session.call('list_gmail_send_as', { accountId: IDS.work });
      if (reason) {
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.reason, reason);
        if (reason === 'api_not_enabled') assert.match(result.text, /enable the Gmail API for the OAuth project/);
      } else {
        assert.deepEqual(result.structuredContent.identities, [{ email: 'primary@synthetic.test' }]);
      }
      assert.equal(JSON.stringify(result).includes(secret), false);
      f.fake.reset();
    }
  } finally { await f.close(); }
});

test('masked listing needs a complete account-bound list and retains only canonical correlation markers', async () => {
  const f = await fixture(['read', 'identity:read']);
  try {
    for (const [body, ok] of [[inventory({ maskedEmails: [{ email: 'mask@synthetic.test', state: 'enabled', clientRequestId: requestId, description: secret }] }), true],
      [inventory({ maskedStatus: 'unknown', reason: 'provider_unavailable' }), false]]) {
      f.fake.override('GET', `/api/accounts/${IDS.work}/sender-identities`, (_req, res) => send(res, body));
      const result = await f.session.call('list_fastmail_masked_aliases', { accountId: IDS.work });
      assert.equal(result.isError === true, !ok);
      if (ok) assert.deepEqual(result.structuredContent.maskedEmails, [{ email: 'mask@synthetic.test', state: 'enabled', clientRequestId: requestId }]);
      assert.equal(JSON.stringify(result).includes(secret), false);
      f.fake.reset();
    }
  } finally { await f.close(); }
});


test('origin validation accepts the same canonical HTTP(S) origin and root-slash forms as the producer', async () => {
  const f = await fixture(['read', 'identity:write']);
  try {
    f.fake.override('POST', `/api/accounts/${IDS.work}/masked-emails`, (_req, res, record) => send(res,
      { accountId: IDS.work, provider: 'fastmail', email: 'mask@synthetic.test', state: 'enabled',
        outcome: 'created', clientRequestId: record.body.clientRequestId }));
    const origins = ['https://shop.synthetic.test', 'https://shop.synthetic.test/', 'http://shop.synthetic.test:8080'];
    for (let i = 0; i < origins.length; i++) {
      const id = `abcdefab-1111-4111-8111-${String(i + 1).padStart(12, '0')}`;
      const result = await f.session.call('create_fastmail_masked_alias', { ...input, clientRequestId: id, forDomain: origins[i] });
      assert.equal(result.isError, undefined);
    }
    assert.equal(f.fake.apiRequests().length, origins.length);
  } finally { await f.close(); }
});

test('a local admission failure stays refused through the real client and SDK without a list or retry', async () => {
  const f = await fixture(['read', 'identity:write']);
  try {
    f.fake.override('POST', `/api/accounts/${IDS.work}/masked-emails`, (_req, res) => send(res,
      { reason: 'admission_unavailable', outcome: 'refused', error: secret }, 503));
    const result = await f.session.call('create_fastmail_masked_alias', input);
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, { accountId: IDS.work,
      reason: 'admission_unavailable', error: 'Creation could not be admitted. No provider request was made.',
      clientRequestId: requestId, outcome: 'refused', mayHaveCompleted: false });
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(/outcome stays unknown|cannot list|correlate clientRequestId/.test(result.text), false);
    assert.equal(f.fake.apiRequests().length, 1);
    assert.equal(f.fake.apiRequests()[0].method, 'POST');
  } finally { await f.close(); }
});
