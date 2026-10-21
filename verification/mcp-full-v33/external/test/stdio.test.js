import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { PassThrough } from 'node:stream';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFakeMailflow, TOKENS, UNKNOWN_TOKEN } from '../test-support/fakeMailflow.js';
import { startStdio } from '../src/stdio.js';
import { VERSION } from '../src/version.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let fake;
test.before(async () => { fake = await startFakeMailflow(); });
test.after(async () => { await fake.close(); });
test.beforeEach(() => { fake.reset(); });

// The parent's environment without any MAILFLOW_ or MCP_ settings of its own.
function cleanEnv(extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MAILFLOW_|MCP_)/.test(key)));
  return { ...env, ...extra };
}

function run(args, env, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: cleanEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timed out: ${stderr}`)); }, timeoutMs);
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end();
  });
}

test('--help and --version', async () => {
  const help = await run(['--help'], {});
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage:\n  mailflow-mcp \[stdio\]/);
  for (const name of ['MAILFLOW_URL', 'MAILFLOW_TOKEN', 'MAILFLOW_TIMEOUT_MS', 'MCP_HTTP_HOST', 'MCP_HTTP_PORT', 'MCP_ALLOWED_HOSTS', 'MCP_ALLOWED_ORIGINS', 'MCP_TRUST_PROXY_HOPS']) {
    assert.ok(help.stdout.includes(name), name);
  }
  const version = await run(['--version'], {});
  assert.equal(version.stdout, `${VERSION}\n`);
  const unknown = await run(['serve'], {});
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown mode "serve"/);
});

test('a stdio session: initialize, tools/list and a tool call against MailFlow', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI],
    env: { ...getDefaultEnvironment(), MAILFLOW_URL: fake.url, MAILFLOW_TOKEN: TOKENS.organize },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    assert.equal(client.getServerVersion().name, 'mailflow-mcp');
    assert.match(client.getInstructions(), /untrusted third-party data/);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 15, 'read and organize tools');
    const result = await client.callTool({ name: 'list_accounts', arguments: {} });
    assert.match(result.content[0].text, /Work <pat@work.example.com>/);
  } finally {
    await client.close();
  }
  const [probe, self] = fake.requests;
  assert.equal(probe.path, '/api/version', 'MailFlow is checked before the token is sent');
  assert.equal(probe.headers.authorization, undefined);
  assert.equal(self.path, '/api/api-tokens/self');
  assert.equal(self.headers.authorization, `Bearer ${TOKENS.organize}`);
  assert.match(stderr, /connected to MailFlow 3\.9\.0 at http:\/\/127\.0\.0\.1:\d+ as pat, token "Claude organize" \(mfat_…/);
  assert.ok(!stderr.includes(TOKENS.organize), 'the token is never printed');
  assert.ok(stderr.includes(TOKENS.organize.slice(-4)));
});

test('a client that writes its requests and then closes stdin still gets every answer', async () => {
  fake.override('GET', '/api/accounts', async () => {
    await new Promise(resolve => setTimeout(resolve, 300));
    return false;
  });
  const child = spawn(process.execPath, [CLI], { env: cleanEnv({ MAILFLOW_URL: fake.url, MAILFLOW_TOKEN: TOKENS.organize }), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  const exited = new Promise(resolve => child.on('exit', resolve));
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pipe', version: '1.0.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_accounts', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'star', arguments: { ids: ['b0000000-0000-4000-8000-000000000001'], starred: true } } },
  ];
  // All at once, then end of input, as `printf … | mailflow-mcp` does.
  child.stdin.end(messages.map(message => `${JSON.stringify(message)}\n`).join(''));
  let timer;
  const code = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve('timed out'), 15000); })]);
  clearTimeout(timer);
  if (code === 'timed out') child.kill();
  assert.equal(code, 0);
  const answers = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(answers.map(answer => answer.id).sort(), [1, 2, 3, 4]);
  const byId = new Map(answers.map(answer => [answer.id, answer]));
  assert.match(byId.get(3).result.content[0].text, /Work <pat@work.example.com>/);
  assert.match(byId.get(4).result.content[0].text, /^Starred: 1 of 1 message changed\./);
});

test('the session ends once every request read before the end of input is answered, not before', async () => {
  fake.override('GET', '/api/accounts', async () => {
    await sleep(300);
    return false;
  });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let output = '';
  stdout.on('data', chunk => { output += chunk; });
  const write = process.stderr.write;
  process.stderr.write = () => true;
  let session;
  try {
    session = await startStdio({ env: { MAILFLOW_URL: fake.url, MAILFLOW_TOKEN: TOKENS.read }, stdin, stdout });
  } finally {
    process.stderr.write = write;
  }
  let ended = false;
  session.closed.then(() => { ended = true; });
  stdin.end([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'in-process', version: '1.0.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_accounts', arguments: {} } },
  ].map(message => `${JSON.stringify(message)}\n`).join(''));
  await sleep(100);
  assert.equal(ended, false, 'a call is still being answered');
  assert.equal(await Promise.race([session.closed.then(() => 'closed'), sleep(3000).then(() => 'still open')]), 'closed');
  const answers = output.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(answers.map(answer => answer.id), [1, 2]);
  assert.match(answers[1].result.content[0].text, /Work <pat@work.example.com>/);
});

test('stdio refuses a token without the read scope', async () => {
  const result = await run([], { MAILFLOW_URL: fake.url, MAILFLOW_TOKEN: TOKENS.draftOnly });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /needs the read scope/);
  assert.equal(result.stdout, '', 'nothing on the protocol channel');
});

test('stdio exits non-zero on a rejected token or a bad configuration, without echoing the token', async () => {
  const rejected = await run([], { MAILFLOW_URL: fake.url, MAILFLOW_TOKEN: UNKNOWN_TOKEN });
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /MailFlow rejected the API token: it is invalid, expired or revoked/);
  assert.ok(!rejected.stderr.includes(UNKNOWN_TOKEN));
  fake.state.tokensEnabled = false;
  const off = await run([], { MAILFLOW_URL: fake.url, MAILFLOW_TOKEN: TOKENS.read });
  assert.match(off.stderr, /turned off on this server/);
  const noUrl = await run([], { MAILFLOW_TOKEN: TOKENS.read });
  assert.equal(noUrl.code, 1);
  assert.match(noUrl.stderr, /MAILFLOW_URL is required/);
  const badToken = await run([], { MAILFLOW_URL: fake.url, MAILFLOW_TOKEN: 'mfat_nope' });
  assert.match(badToken.stderr, /not a MailFlow API token/);
  assert.ok(!badToken.stderr.includes('mfat_nope'));
  const insecure = await run([], { MAILFLOW_URL: 'http://mail.example.com', MAILFLOW_TOKEN: TOKENS.read });
  assert.match(insecure.stderr, /MAILFLOW_ALLOW_INSECURE_HTTP=1/);
});

test('the token is never sent to a URL that is not MailFlow', async () => {
  const seen = [];
  const other = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Some app</title>');
  });
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  try {
    const result = await run([], { MAILFLOW_URL: `http://127.0.0.1:${other.address().port}`, MAILFLOW_TOKEN: TOKENS.read });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /This is not MailFlow's API \(check MAILFLOW_URL\)/);
    assert.deepEqual(seen, [undefined]);
  } finally {
    await new Promise(resolve => other.close(resolve));
  }
});

test('http mode refuses to start with MAILFLOW_TOKEN set', async () => {
  const result = await run(['http'], { MAILFLOW_URL: fake.url, MAILFLOW_TOKEN: TOKENS.read, MCP_HTTP_PORT: '0' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /must not be set in http mode/);
});
