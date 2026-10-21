import { beforeEach, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
vi.mock('./safeFetch.js', () => ({ safeFetch: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
import { safeFetch } from './safeFetch.js';
import { query } from './db.js';
import { encrypt } from './encryption.js';
import { classifyFastmailSender, fastmailConfigRevision, listProviderIdentities, readFastmailIdentities } from './fastmailIdentities.js';

const CORE = 'urn:ietf:params:jmap:core';
const SUB = 'urn:ietf:params:jmap:submission';
const MASK = 'https://www.fastmail.com/dev/maskedemail';
const key = '71'.repeat(32);
const account = { id: 'account-1', enabled: true, smtp_host: 'smtp.fastmail.com', auth_user: 'owner@synthetic.test' };
const session = () => ({ username: account.auth_user, apiUrl: 'https://pod.api.fastmail.com/jmap/api/',
  capabilities: { [CORE]: {}, [SUB]: {}, [MASK]: {} }, primaryAccounts: { [SUB]: 'personal', [MASK]: 'personal' },
  accounts: { personal: { isPersonal: true, accountCapabilities: { [SUB]: {}, [MASK]: {} } } } });
const method = (name, list, tag) => [name, { accountId: 'personal', state: '1', list, notFound: [] }, tag];
const identity = email => ({ id: email, email });
const response = value => new Response(JSON.stringify(value));
function provider({ identities = ['owner@synthetic.test'], masks = [], changeSession, changeMethods } = {}) {
  const s = session(); changeSession?.(s);
  safeFetch.mockImplementation(async (_url, options) => {
    if (!options.method) return response(s);
    const requested = JSON.parse(options.body).methodCalls;
    const methods = requested.map(([name, , tag]) => name === 'Identity/get'
      ? method(name, identities.map(identity), tag) : method(name, masks.map(([email, state]) => ({ id: email, email, state })), tag));
    return response({ methodResponses: changeMethods ? changeMethods(methods) : methods });
  });
}
const read = () => readFastmailIdentities({ ...account, fastmail_api_token: encrypt('synthetic-token') });
beforeEach(() => { process.env.ENCRYPTION_KEY = key; vi.clearAllMocks(); provider(); });

it('reads only the bound personal account, strips metadata and refuses redirects', async () => {
  const result = await read();
  expect(result.identities).toEqual([{ email: 'owner@synthetic.test' }]);
  expect(result.identityStatus).toBe('ready');
  expect(result.maskedStatus).toBe('ready');
  expect(JSON.stringify(result)).not.toMatch(/synthetic-token|enc:v1|personal/);
  expect(safeFetch.mock.calls.every(([, options]) => options.redirect === 'error')).toBe(true);
  expect(safeFetch.mock.calls[1][0]).toBe('https://pod.api.fastmail.com/jmap/api/');
});
it('checks ownership before provider access', async () => {
  query.mockResolvedValue({ rows: [] });
  await expect(listProviderIdentities('other-user', account.id)).rejects.toMatchObject({ status: 404 });
  expect(query).toHaveBeenCalledWith(expect.stringContaining('user_id = $2'), [account.id, 'other-user']);
  expect(safeFetch).not.toHaveBeenCalled();
});
it.each([
  [{ enabled: false }, 'account_disabled'], [{ smtp_host: 'smtp.fastmail.com.evil.test' }, 'unsupported_provider'],
  [{ fastmail_api_token: null }, 'credentials_missing'],
])('does not call the provider for ineligible config %j', async (patch, reason) => {
  const result = await readFastmailIdentities({ ...account, fastmail_api_token: encrypt('synthetic-token'), ...patch });
  expect(result.reason).toBe(reason); expect(safeFetch).not.toHaveBeenCalled();
});
it.each([
  s => { s.username = 'someone@synthetic.test'; },
  s => { s.accounts.personal.isPersonal = false; },
  s => { delete s.primaryAccounts[SUB]; },
])('never silently picks a different account', async changeSession => {
  provider({ changeSession }); expect((await read()).identityStatus).toBe('unknown');
  expect(safeFetch).toHaveBeenCalledTimes(1);
});
it.each(['http://api.fastmail.com/jmap', 'https://api.fastmail.com.evil.test/jmap',
  'https://evil.test/jmap', 'https://name@api.fastmail.com/jmap', 'https://api.fastmail.com:444/jmap'])('rejects advertised API URL %s', async apiUrl => {
  provider({ changeSession: s => { s.apiUrl = apiUrl; } });
  expect((await read()).reason).toBe('invalid_response'); expect(safeFetch).toHaveBeenCalledTimes(1);
});
it('uses effective SMTP login, not the display address or IMAP login', async () => {
  const result = await readFastmailIdentities({ ...account, auth_user: 'imap@synthetic.test', smtp_auth_user: account.auth_user,
    email_address: 'alias@custom.synthetic.test', fastmail_api_token: encrypt('synthetic-token') });
  expect(result.identityStatus).toBe('ready');
});
it('keeps identity and masked capability failures independent', async () => {
  provider({ changeSession: s => { delete s.capabilities[MASK]; } });
  let result = await read();
  expect(result.identityStatus).toBe('ready'); expect(result.maskedStatus).toBe('unsupported');
  expect(classifyFastmailSender(result, account.auth_user)).toBe('allowed');
  expect(classifyFastmailSender(result, 'absent@synthetic.test')).toBe('unknown');
  provider({ changeMethods: methods => [methods[0], ['error', { type: 'forbidden' }, 'masks']] });
  result = await read(); expect(result.identityStatus).toBe('ready'); expect(result.maskedStatus).toBe('unknown');
});
it.each(['pending', 'enabled', 'disabled', 'deleted'])('a known %s mask without Identity is unknown', async state => {
  provider({ masks: [['mask@custom.synthetic.test', state]] });
  const result = await read();
  expect(result.maskedEmails).toEqual([{ email: 'mask@custom.synthetic.test', state }]);
  expect(classifyFastmailSender(result, 'mask@custom.synthetic.test')).toBe('unknown');
});
it.each([
  methods => { methods[0][1].accountId = 'other'; return methods; },
  methods => { methods[0][1].notFound = ['missing']; return methods; },
  methods => { methods[0][1].list = [{ email: 'owner@synthetic.test' }]; return methods; },
  methods => { methods[0][1].list[0].email = 'x\r\n@synthetic.test'; return methods; },
  methods => { methods[0][2] = 'unexpected'; return methods; },
])('malformed/incomplete identity responses never prove absence', async changeMethods => {
  provider({ changeMethods }); const result = await read();
  expect(result.identityStatus).toBe('unknown'); expect(classifyFastmailSender(result, 'absent@synthetic.test')).toBe('unknown');
});
it.each([401, 403, 429, 503])('HTTP %s gives unknown, never unregistered', async status => {
  safeFetch.mockResolvedValue(new Response('private provider details', { status }));
  const result = await read(); expect(result.identityStatus).toBe('unknown');
  expect(JSON.stringify(result)).not.toContain('private provider');
});
it('network failure and oversized/truncated data are unknown without error leakage', async () => {
  safeFetch.mockRejectedValueOnce(new Error('synthetic-token private response'));
  expect((await read()).reason).toBe('provider_unavailable');
  safeFetch.mockResolvedValueOnce(new Response('x'.repeat(1024 * 1024 + 1)));
  expect((await read()).reason).toBe('invalid_response');
  safeFetch.mockResolvedValueOnce(new Response('{'));
  expect((await read()).reason).toBe('invalid_response');
});
it('shares one bounded timeout signal and reports a timed-out request as unknown', async () => {
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  try {
    safeFetch.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Timed out', 'TimeoutError')), { once: true });
    }));
    const pending = read(); controller.abort();
    expect((await pending).reason).toBe('provider_unavailable');
    expect(timeout).toHaveBeenCalledWith(8000);
  } finally { timeout.mockRestore(); }
});
it('refresh observes revocation and never returns the previous inventory on failure', async () => {
  expect(classifyFastmailSender(await read(), account.auth_user)).toBe('allowed');
  provider({ identities: [] }); expect(classifyFastmailSender(await read(), account.auth_user)).toBe('unavailable');
  safeFetch.mockRejectedValue(new Error('offline')); expect(classifyFastmailSender(await read(), account.auth_user)).toBe('unknown');
});
it('generated exact/wildcard decisions do not depend on order or grant sibling domains', () => {
  for (let i = 0; i < 80; i++) {
    const domain = `d${i}.synthetic.test`, email = `person${i}@${domain}`;
    const rows = [{ email: `*@${domain}` }, { email: 'other@synthetic.test' }];
    for (const identities of [rows, [...rows].reverse(), [...rows, ...rows]]) {
      const inventory = { identityStatus: 'ready', maskedStatus: 'ready', identities, maskedEmails: [] };
      expect(classifyFastmailSender(inventory, email)).toBe('allowed');
      for (const bad of [`person${i}@sub.${domain}`, `person${i}@${domain}.evil.test`, `person${i}@evil${domain}`]) {
        expect(classifyFastmailSender(inventory, bad)).toBe('unavailable');
      }
    }
  }
});
it('wildcard identities never affirm malformed candidate local parts', () => {
  for (let i = 0; i < 20; i++) {
    const domain = `d${i}.synthetic.test`;
    const inventory = { identityStatus: 'ready', maskedStatus: 'ready', identities: [{ email: `*@${domain}` }], maskedEmails: [] };
    for (const local of ['', '.', '.name', 'name.', 'bad..name', ',', 'a,b', 'a;b', 'a:b', 'a(b)', 'a<b', 'a>b', 'a\\b', 'a"b', 'a\n', 'a'.repeat(65)]) {
      expect(classifyFastmailSender(inventory, `${local}@${domain}`), local).toBe('unknown');
    }
    for (const local of ['name', 'first.last', 'tag+suffix', 'a'.repeat(64)]) {
      expect(classifyFastmailSender(inventory, `${local}@${domain}`), local).toBe('allowed');
    }
  }
});
it('revision changes with every relevant field and fresh same-plaintext encryption, not presentation', () => {
  const row = { ...account, fastmail_api_token: encrypt('synthetic-token') }, revision = fastmailConfigRevision(row);
  expect(revision).toMatch(/^[a-f0-9]{32}$/);
  for (const patch of [{ id: 'other' }, { enabled: false }, { smtp_host: 'smtp.messagingengine.com' },
    { smtp_auth_user: 'other@synthetic.test' }, { auth_user: null }, { fastmail_api_token: null },
    { fastmail_api_token: encrypt('synthetic-token') }]) expect(fastmailConfigRevision({ ...row, ...patch })).not.toBe(revision);
  expect(fastmailConfigRevision({ ...row, name: 'Different', color: 'blue', signature: 'new' })).toBe(revision);
  expect(fastmailConfigRevision({ ...row, smtp_auth_user: '' })).not.toBe(fastmailConfigRevision({ ...row, smtp_auth_user: null }));
});
it('revision is stable across fresh processes, rotates with key and is null without a usable key', () => {
  const script = `import { fastmailConfigRevision } from './src/services/fastmailIdentities.js'; console.log(JSON.stringify(fastmailConfigRevision(${JSON.stringify(account)})));`;
  const run = encryptionKey => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('../../', import.meta.url), env: { ...process.env, ENCRYPTION_KEY: encryptionKey }, encoding: 'utf8', timeout: 5000,
    });
    expect(child.status).toBe(0); return JSON.parse(child.stdout.trim());
  };
  expect(run(key)).toBe(run(key)); expect(run('72'.repeat(32))).not.toBe(run(key));
  expect(run('')).toBe(null); expect(run('invalid')).toBe(null);
}, 15000);
