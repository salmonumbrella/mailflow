import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MailflowClient } from '../src/mailflowClient.js';
import { createMailflowServer } from '../src/server.js';

// A block's real markers: the tags that carry its id.
const OPEN = /<untrusted-email-content id="([A-Za-z0-9_-]{12})">/g;
const CLOSE = /<\/untrusted-email-content id="([A-Za-z0-9_-]{12})">/g;

// An SDK client talking to a fresh server over a linked in-memory pair, as an MCP host would.
export async function connect({ fake, token, scopes, timeoutMs = 10000, calls = null }) {
  const mailflow = new MailflowClient({ baseUrl: fake.url, token, timeoutMs });
  const server = createMailflowServer({ client: mailflow, scopes, calls });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'mailflow-mcp-test', version: '1.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    mailflow,
    server,
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      return { ...result, text: (result.content || []).map(part => part.text ?? '').join('\n') };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

export function count(text, needle) {
  return text.split(needle).length - 1;
}

export function blockMarkers(text) {
  return { opens: [...text.matchAll(OPEN)], closes: [...text.matchAll(CLOSE)] };
}

// Exactly one block, closed with its own id, and the marker's name nowhere else in the result.
export function assertOneBlock(text) {
  const { opens, closes } = blockMarkers(text);
  assert.equal(opens.length, 1, 'one opening marker');
  assert.equal(closes.length, 1, 'one closing marker');
  assert.equal(closes[0][1], opens[0][1], 'the block closes with its own id');
  assert.ok(closes[0].index > opens[0].index);
  assert.equal(count(text.toLowerCase(), 'untrusted-email-content'), 2, 'the marker name appears only in the two markers');
}

// The single untrusted block of a result, or null.
export function untrustedPart(text) {
  const { opens, closes } = blockMarkers(text);
  if (opens.length !== 1 || closes.length !== 1 || closes[0][1] !== opens[0][1]) return null;
  return text.slice(opens[0].index + opens[0][0].length, closes[0].index);
}

export function outsideUntrusted(text) {
  const { opens, closes } = blockMarkers(text);
  if (!opens.length || !closes.length) return text;
  return text.slice(0, opens[0].index) + text.slice(closes[0].index + closes[0][0].length);
}
