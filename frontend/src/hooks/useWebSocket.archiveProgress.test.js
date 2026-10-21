import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true }
    : nextLoad(url, context);
} });
const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
after(() => dom.window.close());
let socket;
globalThis.WebSocket = class {
  static CLOSED = 3;
  constructor() { socket = this; this.readyState = 1; }
  close() { this.readyState = 3; }
};
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { useWebSocket } = await import('./useWebSocket.js');
function App() { useWebSocket(); return null; }

// Drive the real consumer with the emission name from the real server worker.
// An accidental return to backfill_progress must fail the behavioral oracle.
const server = readFileSync(new URL('../../../backend/src/services/imapManager.js', import.meta.url), 'utf8');
const start = server.indexOf('async runArchiveCoverageBatch(account,');
const worker = server.slice(start, server.indexOf('async bootstrapProviderIdentity', start));
const emission = worker.match(/this\.broadcast\(\{\s*type:\s*'([^']+)'/);
assert.ok(start >= 0 && emission, 'archive worker emits its own honest progress event');

for (const active of [false, true]) {
  test(`archive coverage preserves ${active ? 'active real' : 'idle'} backfill progress`, async () => {
    useStore.setState({ backfillProgress: { other: { synced: 2, total: 20 } } });
    const root = createRoot(document.getElementById('root'));
    let refreshes = 0;
    const refreshed = () => refreshes++;
    window.addEventListener('mailflow:refresh', refreshed);
    const emit = async data => React.act(async () => socket.onmessage({ data: JSON.stringify(data) }));
    try {
      await React.act(async () => root.render(React.createElement(App)));
      if (active) await emit({ type: 'backfill_progress', accountId: 'a', synced: 7, total: 100 });
      const previous = useStore.getState().backfillProgress;
      assert.deepEqual(previous, active
        ? { other: { synced: 2, total: 20 }, a: { synced: 7, total: 100 } }
        : { other: { synced: 2, total: 20 } });
      for (const progress of [{ stored: 0, suppressed: 0, pending: true },
        { stored: 3, suppressed: 2, pending: 0 }, { stored: 0, suppressed: 1, pending: 1 }]) {
        await emit({ type: emission[1], accountId: 'a', phase: 'archive', ...progress });
        assert.equal(useStore.getState().backfillProgress, previous, 'archive event neither starts nor clears real backfill');
      }
      assert.equal(refreshes, 0, 'archive coverage does not fabricate a backfill completion refresh');
      if (active) {
        await emit({ type: 'backfill_progress', accountId: 'a', synced: 8, total: 100 });
        assert.deepEqual(useStore.getState().backfillProgress.a, { synced: 8, total: 100 });
        await emit({ type: 'backfill_all_complete', accountId: 'a' });
        assert.equal(useStore.getState().backfillProgress.a, null, 'genuine completion still clears genuine progress');
        assert.deepEqual(useStore.getState().backfillProgress.other, { synced: 2, total: 20 });
      }
    } finally {
      // Cancel the genuine progress debounce, including when an assertion fails.
      await emit({ type: 'backfill_all_complete', accountId: 'a' });
      await React.act(async () => root.unmount());
      window.removeEventListener('mailflow:refresh', refreshed);
    }
  });
}
