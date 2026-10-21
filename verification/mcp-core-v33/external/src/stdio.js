import { setTimeout as sleep } from 'node:timers/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, maskToken } from './config.js';
import { MailflowClient } from './mailflowClient.js';
import { createMailflowServer, normalizeScopes } from './server.js';
import { ScopeError, NEEDS_READ_SCOPE } from './errors.js';
import { oneLine } from './format.js';
import { VERSION } from './version.js';

// Everything goes to stderr: stdout carries the protocol.
function log(message) {
  process.stderr.write(`[mailflow-mcp] ${message}\n`);
}

// The stdio transport, keeping count of the requests it has received and not yet answered, so the
// session can end once the client has had every answer. The SDK sends an answer a little after
// the handler returns, so counting handlers would end it a moment too early.
class AnsweringTransport extends StdioServerTransport {
  #handler = undefined;
  #unanswered = new Set();
  #waiting = [];

  set onmessage(handler) {
    this.#handler = handler;
  }

  get onmessage() {
    return this.#handler && ((message, extra) => {
      // A request the client cancels gets no answer.
      if (message?.method === 'notifications/cancelled') this.#answered(message.params?.requestId);
      else if (message?.method && message.id !== undefined) this.#unanswered.add(message.id);
      this.#handler(message, extra);
    });
  }

  async send(message, options) {
    await super.send(message, options);
    if (!message?.method && message?.id !== undefined) this.#answered(message.id);
  }

  get unanswered() {
    return this.#unanswered.size;
  }

  allAnswered() {
    return this.#unanswered.size ? new Promise(resolve => this.#waiting.push(resolve)) : Promise.resolve();
  }

  #answered(id) {
    this.#unanswered.delete(id);
    if (!this.#unanswered.size) for (const resolve of this.#waiting.splice(0)) resolve();
  }
}

export async function startStdio({ env = process.env, stdin = process.stdin, stdout = process.stdout } = {}) {
  const config = loadConfig('stdio', env);
  for (const warning of config.warnings) log(`warning: ${warning}`);
  const client = new MailflowClient({ baseUrl: config.mailflowUrl, token: config.token, timeoutMs: config.timeoutMs });
  // The public version probe goes first, so the token is only sent once MAILFLOW_URL is known to be MailFlow.
  const version = await client.getVersion();
  const self = await client.getSelf();
  const scopes = normalizeScopes(self.scopes);
  if (!scopes.includes('read')) throw new ScopeError(NEEDS_READ_SCOPE);

  const server = createMailflowServer({ client, scopes });
  const transport = new AnsweringTransport(stdin, stdout);
  await server.connect(transport);
  log(`${VERSION} connected to MailFlow ${oneLine(version.version, 40)} at ${config.origin} as ${oneLine(self.username || 'unknown user', 80)}, token "${oneLine(self.name || '', 60)}" (${maskToken(config.token)}), scopes ${scopes.join(', ')}`);

  let closing = null;
  const close = () => {
    if (!closing) closing = server.close().catch(() => {});
    return closing;
  };
  // The client closing its end of stdin is the normal way a session ends. Closing the server
  // drops the answer to every request still being worked on, so those already received are
  // answered first: a client that writes its requests and then closes stdin gets every answer.
  // One still unanswered after twice the MailFlow timeout is given up, and that is logged.
  const graceMs = 2 * config.timeoutMs;
  const closed = new Promise(resolve => {
    stdin.once('end', async () => {
      const answered = await Promise.race([transport.allAnswered().then(() => true), sleep(graceMs, false, { ref: false })]);
      if (!answered) log(`stdin closed; giving up on ${transport.unanswered} request${transport.unanswered === 1 ? '' : 's'} still unanswered after ${Math.round(graceMs / 1000)} s`);
      await close();
      resolve();
    });
  });
  return { server, close, closed };
}
