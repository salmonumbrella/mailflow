import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function activeStructure(source) {
  const lines = source.split('\n');
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/#.*$/, '').trim();
    if (!line) continue;
    if (/^location\b/.test(line)) assert.ok(stack.includes('server'), `line ${i + 1}: location outside a server`);
    for (const brace of line.matchAll(/[{}]/g)) {
      if (brace[0] === '{') stack.push(/^server\s*\{/.test(line) ? 'server' : 'block');
      else assert.ok(stack.pop(), `line ${i + 1}: unmatched closing brace`);
    }
  }
  assert.deepEqual(stack, [], 'active nginx blocks must all close');
}

test('native nginx example has balanced active blocks and locations only inside servers', () => {
  const source = readFileSync(new URL('../../contrib/nginx.conf', import.meta.url), 'utf8');
  activeStructure(source);
  assert.throws(() => activeStructure(`${source}\nlocation /api/ {`), /outside a server/);
  assert.throws(() => activeStructure('server {\nlocation /api/ {\n}\n'), /must all close/);
});

test('the public GIF mount precedes all session, parser, CORS and telemetry middleware', () => {
  const source = readFileSync(new URL('../../backend/src/index.js', import.meta.url), 'utf8');
  const publicMount = source.indexOf("app.use('/api/open-activity/pixel', publicOpenActivity)");
  assert.ok(publicMount > 0);
  for (const marker of ['const sessionMiddleware = session(', 'app.use(corsExceptDav(', 'recordHttp(`${req.method}', 'mountApiAuth(app, sessionMiddleware)']) {
    assert.ok(source.indexOf(marker) > publicMount, `${marker} must stay after pixel mount`);
  }
});
