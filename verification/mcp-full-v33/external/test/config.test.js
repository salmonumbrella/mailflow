import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isTokenFormat, maskToken, parseMailflowUrl, isLocalHost, loadConfig, parseHostList, parseOriginList,
  hostnameOf, ConfigError, DEFAULT_TIMEOUT_MS,
} from '../src/config.js';

const TOKEN = `mfat_${'Ab3-_'.repeat(8)}xyz`;

test('the token format is mfat_ and 43 base64url characters', () => {
  assert.equal(TOKEN.length, 48);
  assert.equal(isTokenFormat(TOKEN), true);
  assert.equal(isTokenFormat(TOKEN.slice(0, -1)), false, 'one short');
  assert.equal(isTokenFormat(`${TOKEN}a`), false, 'one long');
  assert.equal(isTokenFormat(TOKEN.replace('mfat_', 'mfak_')), false, 'wrong prefix');
  assert.equal(isTokenFormat(TOKEN.replace('A', '+')), false, 'not base64url');
  assert.equal(isTokenFormat(` ${TOKEN}`), false, 'whitespace');
  assert.equal(isTokenFormat(undefined), false);
});

test('a masked token shows at most its last four characters', () => {
  assert.equal(maskToken(TOKEN), `mfat_…${TOKEN.slice(-4)}`);
  assert.ok(!maskToken(TOKEN).includes(TOKEN.slice(5, 20)));
});

test('MAILFLOW_URL loses trailing slashes and keeps a path', () => {
  assert.equal(parseMailflowUrl('https://mail.example.com/').baseUrl, 'https://mail.example.com');
  assert.equal(parseMailflowUrl('https://mail.example.com///').baseUrl, 'https://mail.example.com');
  assert.equal(parseMailflowUrl('  https://mail.example.com:8443/mailflow/ ').baseUrl, 'https://mail.example.com:8443/mailflow');
});

test('MAILFLOW_URL refuses a query, a fragment, credentials, /api and other schemes', () => {
  for (const value of ['https://mail.example.com/?x=1', 'https://mail.example.com/#top', 'https://mail.example.com?']) {
    assert.throws(() => parseMailflowUrl(value), /query string or a fragment/, value);
  }
  assert.throws(() => parseMailflowUrl('https://user:pw@mail.example.com'), /user name or password/);
  assert.throws(() => parseMailflowUrl('https://mail.example.com/api/'), /without \/api/);
  assert.throws(() => parseMailflowUrl('ftp://mail.example.com'), /must start with https/);
  assert.throws(() => parseMailflowUrl('mail.example.com'), ConfigError);
  assert.throws(() => parseMailflowUrl(''), /MAILFLOW_URL is required/);
});

test('plain http is allowed only to loopback, private, link-local and container hosts', () => {
  for (const host of ['127.0.0.1', '127.8.9.10', 'localhost', 'mail.localhost', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.20', '169.254.1.1', '[::1]', '[fd12:3456::1]', '[fe80::1]', '[::ffff:192.168.1.5]', 'backend', 'mailflow-backend', 'mailflow_backend']) {
    const result = parseMailflowUrl(`http://${host}:3000`);
    assert.equal(result.insecure, false, host);
  }
  for (const host of ['mail.example.com', '8.8.8.8', '172.32.0.1', '192.169.0.1', '[2001:db8::1]', '[::ffff:8.8.8.8]', 'server.local']) {
    assert.throws(() => parseMailflowUrl(`http://${host}`), /MAILFLOW_ALLOW_INSECURE_HTTP=1/, host);
  }
});

test('MAILFLOW_ALLOW_INSECURE_HTTP=1 allows public http and says so', () => {
  const config = loadConfig('stdio', { MAILFLOW_URL: 'http://mail.example.com', MAILFLOW_TOKEN: TOKEN, MAILFLOW_ALLOW_INSECURE_HTTP: '1' });
  assert.equal(config.mailflowUrl, 'http://mail.example.com');
  assert.match(config.warnings.join('\n'), /unencrypted http/);
  assert.throws(() => loadConfig('stdio', { MAILFLOW_URL: 'http://mail.example.com', MAILFLOW_TOKEN: TOKEN, MAILFLOW_ALLOW_INSECURE_HTTP: 'true' }), /MAILFLOW_ALLOW_INSECURE_HTTP=1/);
});

test('isLocalHost judges names and addresses', () => {
  assert.equal(isLocalHost('backend'), true);
  assert.equal(isLocalHost('example.com'), false);
  assert.equal(isLocalHost(''), false);
});

test('stdio mode needs a well-formed token and never echoes it', () => {
  assert.throws(() => loadConfig('stdio', { MAILFLOW_URL: 'https://mail.example.com' }), /MAILFLOW_TOKEN is required/);
  const bad = 'mfat_tooShortToBeReal';
  assert.throws(() => loadConfig('stdio', { MAILFLOW_URL: 'https://mail.example.com', MAILFLOW_TOKEN: bad }), err => {
    assert.match(err.message, /not a MailFlow API token/);
    assert.ok(!err.message.includes(bad));
    return true;
  });
  const config = loadConfig('stdio', { MAILFLOW_URL: 'https://mail.example.com/', MAILFLOW_TOKEN: ` ${TOKEN}\n` });
  assert.equal(config.token, TOKEN);
  assert.equal(config.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(DEFAULT_TIMEOUT_MS, 60000);
});

test('MAILFLOW_TIMEOUT_MS must be a whole number in range', () => {
  const env = { MAILFLOW_URL: 'https://mail.example.com', MAILFLOW_TOKEN: TOKEN };
  assert.equal(loadConfig('stdio', { ...env, MAILFLOW_TIMEOUT_MS: '45000' }).timeoutMs, 45000);
  for (const value of ['abc', '-5', '1.5', '999', '600001']) {
    assert.throws(() => loadConfig('stdio', { ...env, MAILFLOW_TIMEOUT_MS: value }), /MAILFLOW_TIMEOUT_MS must be a whole number/, value);
  }
});

test('http mode refuses to start with MAILFLOW_TOKEN set', () => {
  assert.throws(() => loadConfig('http', { MAILFLOW_URL: 'http://backend:3000', MAILFLOW_TOKEN: TOKEN }), /must not be set in http mode/);
});

test('http mode defaults and parsing', () => {
  const config = loadConfig('http', { MAILFLOW_URL: 'http://backend:3000' });
  assert.deepEqual(config.http, { host: '127.0.0.1', port: 8787, allowedHosts: [], allowedOrigins: [], trustProxyHops: 0 });
  assert.match(config.warnings.join('\n'), /MCP_ALLOWED_HOSTS is not set/);
  const custom = loadConfig('http', {
    MAILFLOW_URL: 'http://backend:3000',
    MCP_HTTP_HOST: '0.0.0.0',
    MCP_HTTP_PORT: '0',
    MCP_ALLOWED_HOSTS: ' MCP.Example.com:443 , localhost,https://other.example.com/x,[::1]:8787',
    MCP_ALLOWED_ORIGINS: 'https://Claude.ai, https://claude.ai/',
    MCP_TRUST_PROXY_HOPS: '1',
  });
  assert.deepEqual(custom.http.allowedHosts, ['mcp.example.com', 'localhost', 'other.example.com', '::1']);
  assert.deepEqual(custom.http.allowedOrigins, ['https://claude.ai']);
  assert.equal(custom.http.port, 0);
  assert.equal(custom.http.trustProxyHops, 1);
  assert.deepEqual(custom.warnings, []);
  assert.throws(() => loadConfig('http', { MAILFLOW_URL: 'http://backend:3000', MCP_TRUST_PROXY_HOPS: '11' }), /MCP_TRUST_PROXY_HOPS/);
  assert.throws(() => loadConfig('http', { MAILFLOW_URL: 'http://backend:3000', MCP_HTTP_PORT: '70000' }), /MCP_HTTP_PORT/);
});

test('allowed host and origin lists reject what they cannot use', () => {
  assert.throws(() => parseHostList('mcp example.com'), /not a host name/);
  assert.throws(() => parseHostList('user@mcp.example.com'), /not a host name/);
  assert.throws(() => parseOriginList('claude.ai'), /not an origin/);
  assert.throws(() => parseOriginList('ftp://claude.ai'), /not an origin/);
  assert.deepEqual(parseHostList(undefined), []);
});

test('hostnameOf drops ports and IPv6 brackets', () => {
  assert.equal(hostnameOf('MCP.example.com:8443'), 'mcp.example.com');
  assert.equal(hostnameOf('[::1]:8787'), '::1');
  assert.equal(hostnameOf('127.0.0.1'), '127.0.0.1');
  assert.equal(hostnameOf(undefined), '');
});
