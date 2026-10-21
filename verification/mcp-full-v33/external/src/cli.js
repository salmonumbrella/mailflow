#!/usr/bin/env node
import { VERSION } from './version.js';

const HELP = `mailflow-mcp ${VERSION}: an MCP server for a self-hosted MailFlow, using a MailFlow API token.

Usage:
  mailflow-mcp [stdio]   Serve one MCP client over stdin/stdout (the default)
  mailflow-mcp http      Serve remote MCP clients over Streamable HTTP at /mcp
  mailflow-mcp --help    Show this help
  mailflow-mcp --version Show the version

Environment (both modes):
  MAILFLOW_URL                   MailFlow's address, e.g. https://mail.example.com (required)
  MAILFLOW_TIMEOUT_MS            Time allowed for each MailFlow request (default 60000)
  MAILFLOW_ALLOW_INSECURE_HTTP=1 Allow http:// to a public address (the token would travel unencrypted)

stdio mode:
  MAILFLOW_TOKEN                 An API token (mfat_…) from MailFlow, Settings → Security → API tokens (required)

http mode (each caller sends its own token as Authorization: Bearer mfat_…; MAILFLOW_TOKEN must not be set):
  MCP_HTTP_HOST                  Address to listen on (default 127.0.0.1)
  MCP_HTTP_PORT                  Port to listen on (default 8787)
  MCP_ALLOWED_HOSTS              Comma-separated host names /mcp answers to, e.g. mcp.example.com
  MCP_ALLOWED_ORIGINS            Comma-separated origins allowed to send an Origin header (default: none)
  MCP_TRUST_PROXY_HOPS           Number of reverse proxies in front, for the client address (default 0)

More: https://github.com/Monkey7539/mailflow-mcp#readme
`;

// The process is left to end by itself: on Windows, Node can abort in libuv when process.exit()
// runs while fetch's handles are closing. The unref'd timer fires only if something still holds
// the process open after the grace period.
function finish(code, graceMs = 5000) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), graceMs).unref();
}

function fail(message) {
  process.stderr.write(`mailflow-mcp: ${message}\n`);
  finish(1);
}

async function main(argv) {
  const args = argv.filter(arg => arg !== '');
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args.length > 1) return fail(`expected one mode, got: ${args.join(' ')} (see --help)`);
  const mode = args[0] || 'stdio';
  if (mode === 'stdio') {
    const { startStdio } = await import('./stdio.js');
    const session = await startStdio();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { session.close().finally(() => finish(0)); });
    await session.closed;
    return finish(0);
  }
  if (mode === 'http') {
    const { startHttp } = await import('./http.js');
    const { close } = await startHttp();
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        process.stderr.write(`[mailflow-mcp] ${signal}: finishing requests in flight\n`);
        close().finally(() => finish(0, 1000));
      });
    }
    return;
  }
  return fail(`unknown mode ${JSON.stringify(mode)} (use stdio or http; see --help)`);
}

main(process.argv.slice(2)).catch(err => fail(err?.message || String(err)));
