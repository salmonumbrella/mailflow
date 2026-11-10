import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createGmailDensityPersistence, readDensityIntent, readDensityCache, GMAIL_DENSITY_INTENT_KEY, GMAIL_DENSITY_SNAPSHOT_KEY } from './gmailDensityPersistence.js';

const settle = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
function harness() {
  const values = new Map();
  const storage = { get length() { return values.size; }, key: index => [...values.keys()][index],
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const server = { gmailDensity: 'default', gmailDensityRevision: 0 };
  const requests = [];
  const pages = [];
  const page = () => {
    const context = { userId: 'user-a', locked: false, session: 0 };
    const states = [];
    const persistence = createGmailDensityPersistence({ storage, getContext: () => context,
      read: async () => ({ ...server }), onState: value => states.push(value),
      save: body => new Promise((resolve, reject) => requests.push({ body,
        rejectTransport: () => reject(new Error('connection lost; commit unknown')),
        commit: () => {
          if (body.expectedRevision !== server.gmailDensityRevision) {
            reject(Object.assign(new Error('conflict'), { status: 409, ...server }));
            return false;
          }
          server.gmailDensity = body.gmailDensity;
          server.gmailDensityRevision++;
          resolve({ ok: true, ...server });
          return true;
        },
      })),
    });
    const result = { persistence, context, states };
    pages.push(result);
    return result;
  };
  return { storage, server, requests, page, pages, intent: () => readDensityIntent(storage, 'user-a') };
}
beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
afterEach(() => mock.timers.reset());

test('a reloaded page commits compact before an old comfortable request; the old request cannot overwrite or retry', async () => {
  const h = harness();
  const first = h.page();
  first.persistence.choose('comfortable'); void first.persistence.flush(); await settle();
  assert.equal(h.requests.length, 1);
  first.persistence.choose('compact'); void first.persistence.flush();
  const reloaded = h.page();
  reloaded.persistence.retry(); void reloaded.persistence.flush(); await settle();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].commit(), true); await settle();
  const saved = h.intent();
  assert.equal(saved.pending, false);
  assert.equal(reloaded.states.at(-1), 'saved');
  assert.equal(h.requests[0].commit(), false); await settle();
  assert.equal(h.requests.length, 2, 'an older page must not rebase the old intent');
  assert.deepEqual(h.server, { gmailDensity: 'compact', gmailDensityRevision: 1 });
  assert.deepEqual(h.intent(), saved);
});

test('a rejected browser promise does not let its detached late database write defeat the newer choice', async () => {
  const h = harness();
  const { persistence, states } = h.page();
  persistence.choose('comfortable'); void persistence.flush(); await settle();
  persistence.choose('compact'); void persistence.flush();
  h.requests[0].rejectTransport(); await settle();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].commit(), true); await settle();
  assert.equal(h.requests[0].commit(), false);
  assert.deepEqual(h.server, { gmailDensity: 'compact', gmailDensityRevision: 1 });
  assert.equal(states.at(-1), 'saved');
  assert.equal(h.intent().pending, false);
});

test('a lost response after commit reconciles through conflict and applies the newest local value', async () => {
  const h = harness();
  const { persistence, states } = h.page();
  persistence.choose('comfortable'); void persistence.flush(); await settle();
  h.requests[0].rejectTransport();
  assert.equal(h.requests[0].commit(), true); await settle();
  assert.equal(states.at(-1), 'failed');
  assert.equal(h.intent().pending, true);
  persistence.choose('compact'); void persistence.flush(); await settle();
  assert.equal(h.requests[1].commit(), false); await settle();
  assert.equal(h.requests[2].body.expectedRevision, 1);
  assert.equal(h.requests[2].commit(), true); await settle();
  assert.deepEqual(h.server, { gmailDensity: 'compact', gmailDensityRevision: 2 });
  assert.equal(states.at(-1), 'saved');
});

test('matching read/conflict values do not acknowledge until a successful increment fences older dispatched writes', async () => {
  const h = harness();
  const { persistence, states } = h.page();
  h.server.gmailDensity = 'compact';
  persistence.choose('compact'); void persistence.flush(); await settle();
  assert.equal(states.at(-1), 'pending');
  h.server.gmailDensityRevision = 1;
  assert.equal(h.requests[0].commit(), false); await settle();
  assert.equal(states.at(-1), 'pending');
  assert.equal(h.requests[1].body.expectedRevision, 1);
  assert.equal(h.requests[1].commit(), true); await settle();
  assert.equal(states.at(-1), 'saved');
  assert.equal(h.server.gmailDensityRevision, 2);
});

test('an old same-value completion cannot acknowledge a newer ABA intent token', async () => {
  const h = harness();
  const first = h.page();
  first.persistence.choose('compact'); void first.persistence.flush(); await settle();
  const oldToken = h.intent().token;
  const second = h.page();
  second.persistence.choose('comfortable'); second.persistence.choose('compact');
  assert.notEqual(h.intent().token, oldToken);
  assert.equal(h.requests[0].commit(), true); await settle();
  assert.equal(h.intent().pending, true);
  assert.equal(first.states.includes('saved'), false);
  void second.persistence.flush(); await settle();
  assert.equal(h.requests[1].commit(), false); await settle();
  assert.equal(h.requests[2].commit(), true); await settle();
  assert.equal(second.states.at(-1), 'saved');
});

test('conflicts are bounded and retry preserves the pending token and choice', async () => {
  const h = harness();
  const { persistence, states } = h.page();
  persistence.choose('compact'); void persistence.flush(); await settle();
  const token = h.intent().token;
  for (let i = 0; i < 3; i++) {
    h.server.gmailDensityRevision++;
    assert.equal(h.requests[i].commit(), false); await settle();
  }
  assert.equal(h.requests.length, 3);
  assert.equal(states.at(-1), 'failed');
  assert.equal(h.intent().token, token);
  assert.equal(h.intent().value, 'compact');
  assert.equal(h.intent().pending, true);
  persistence.retry(); void persistence.flush(); await settle();
  assert.equal(h.requests[3].commit(), false); await settle();
  assert.equal(h.requests[4].commit(), true); await settle();
  assert.equal(states.at(-1), 'saved');
});

test('lock/user/session transitions prevent an old conflict from causing another mutation or acknowledgment', async () => {
  for (const change of ['locked', 'userId', 'session']) {
    const h = harness();
    const { persistence, context, states } = h.page();
    persistence.choose('compact'); void persistence.flush(); await settle();
    context[change] = change === 'locked' ? true : change === 'userId' ? 'user-b' : 1;
    h.server.gmailDensityRevision++;
    assert.equal(h.requests[0].commit(), false); await settle();
    assert.equal(h.requests.length, 1);
    assert.deepEqual(states, ['pending']);
    assert.equal(h.intent().pending, true);
  }
});

test('the complete durable envelope is canonical when interrupted display-cache writes disagree', async () => {
  const h = harness();
  const first = h.page();
  first.persistence.choose('compact');
  h.storage.setItem('mailflow_gmail_density', 'comfortable');
  const reloaded = h.page();
  reloaded.persistence.retry(); void reloaded.persistence.flush(); await settle();
  assert.equal(h.requests[0].body.gmailDensity, 'compact');
  h.requests[0].commit(); await settle();
  assert.equal(h.intent().pending, false);
  assert.equal(typeof JSON.parse(h.storage.getItem(GMAIL_DENSITY_INTENT_KEY)).token, 'string');
});

test('hydration never replaces a newer acknowledged server revision or its durable intent', async () => {
  const h = harness();
  const first = h.page();
  first.persistence.hydrate('default', 0);
  const second = h.page();
  second.persistence.choose('compact'); void second.persistence.flush(); await settle();
  h.requests[0].commit(); await settle();
  const saved = h.intent();
  assert.equal(first.persistence.hydrate('default', 0), false);
  assert.deepEqual(h.intent(), saved);
});

test('423 only signals lock after the originating user/session/intent is verified', async () => {
  for (const stage of ['read', 'save']) for (const stale of [false, true]) {
    const values = new Map();
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
    const context = { userId: 'user-a', locked: false, session: 0 };
    let reject, locks = 0;
    const failing = () => new Promise((_resolve, fail) => { reject = fail; });
    const persistence = createGmailDensityPersistence({ storage, getContext: () => context,
      read: stage === 'read' ? failing : async () => ({ gmailDensity: 'default', gmailDensityRevision: 0 }),
      save: failing, onState() {}, onLocked: () => { locks++; },
    });
    persistence.choose('compact'); void persistence.flush(); await settle();
    if (stale) { context.userId = 'user-b'; context.session++; persistence.cancel(); }
    reject(Object.assign(new Error('Locked'), { status: 423 })); await settle();
    assert.equal(locks, stale ? 0 : 1, `${stage} stale=${stale}`);
  }
});

test('the final safe integer revision is acknowledged, then further writes fail without invalid CAS requests', async () => {
  const h = harness();
  const { persistence, states } = h.page();
  h.server.gmailDensityRevision = Number.MAX_SAFE_INTEGER - 1;
  persistence.choose('compact'); void persistence.flush(); await settle();
  h.requests[0].commit(); await settle();
  assert.equal(states.at(-1), 'saved');
  assert.equal(h.intent().revision, Number.MAX_SAFE_INTEGER);
  persistence.choose('comfortable'); void persistence.flush(); await settle();
  assert.equal(h.requests.length, 1);
  assert.equal(states.at(-1), 'failed');
  assert.equal(h.intent().pending, true);
});

test('an acknowledgment interleaved with another tab choosing cannot rewrite or acknowledge the newer token', async () => {
  const h = harness();
  const first = h.page(), second = h.page();
  first.persistence.choose('compact'); void first.persistence.flush(); await settle();
  const oldHead = h.storage.getItem(GMAIL_DENSITY_INTENT_KEY);
  const set = h.storage.setItem;
  let newerHead;
  h.storage.setItem = (key, value) => {
    if (key.startsWith('mailflow_gmail_density_ack:')) {
      h.storage.setItem = set;
      second.persistence.choose('comfortable');
      newerHead = h.storage.getItem(GMAIL_DENSITY_INTENT_KEY);
    }
    set(key, value);
  };
  h.requests[0].commit(); await settle();
  assert.notEqual(newerHead, oldHead);
  assert.equal(h.storage.getItem(GMAIL_DENSITY_INTENT_KEY), newerHead);
  assert.equal(h.intent().value, 'comfortable');
  assert.equal(h.intent().pending, true);
  assert.equal(first.states.includes('saved'), false);
  void second.persistence.flush(); await settle();
  h.requests[1].commit(); await settle();
  if (h.requests[2]) { h.requests[2].commit(); await settle(); }
  assert.equal(h.server.gmailDensity, 'comfortable');
  assert.equal(h.intent().pending, false);
  const reloaded = h.page();
  assert.equal(reloaded.persistence.retry(), false, 'matching token receipt survives reload');
});

test('hydration and observed revisions never rewrite the intent pointer, including a competing choice during cache write', async () => {
  const h = harness();
  const first = h.page(), second = h.page();
  first.persistence.choose('compact'); void first.persistence.flush(); await settle();
  h.requests[0].commit(); await settle();
  const head = h.storage.getItem(GMAIL_DENSITY_INTENT_KEY);
  first.persistence.observeRevision(2);
  assert.equal(h.storage.getItem(GMAIL_DENSITY_INTENT_KEY), head);
  const set = h.storage.setItem;
  let newerHead;
  h.storage.setItem = (key, value) => {
    if (key.startsWith(GMAIL_DENSITY_SNAPSHOT_KEY + ':')) {
      h.storage.setItem = set;
      second.persistence.choose('comfortable');
      newerHead = h.storage.getItem(GMAIL_DENSITY_INTENT_KEY);
    }
    set(key, value);
  };
  first.persistence.hydrate('default', 2);
  assert.equal(h.storage.getItem(GMAIL_DENSITY_INTENT_KEY), newerHead);
  assert.equal(h.intent().pending, true);
  assert.equal(readDensityCache(h.storage, 'user-a').value, 'comfortable');
});

test('snapshot cache remains monotonic under interleaved older/newer GET writes', () => {
  const h = harness();
  const first = h.page(), second = h.page();
  const set = h.storage.setItem;
  h.storage.setItem = (key, value) => {
    if (key === `${GMAIL_DENSITY_SNAPSHOT_KEY}:user-a:1`) {
      h.storage.setItem = set;
      second.persistence.hydrate('compact', 2);
    }
    set(key, value);
  };
  first.persistence.hydrate('comfortable', 1);
  assert.deepEqual(readDensityCache(h.storage, 'user-a'), { userId: 'user-a', value: 'compact', revision: 2 });
  assert.equal(h.storage.getItem(GMAIL_DENSITY_INTENT_KEY), null, 'GET never creates a local intent');
});

test('receipt/cache cleanup is bounded and preserves the latest immutable pending choice', async () => {
  const h = harness();
  const { persistence } = h.page();
  for (let n = 0; n < 60; n++) {
    persistence.choose(n % 2 ? 'compact' : 'comfortable'); void persistence.flush(); await settle();
    h.requests.at(-1).commit(); await settle();
    persistence.hydrate(h.server.gmailDensity, h.server.gmailDensityRevision);
  }
  persistence.choose('default');
  const latest = h.storage.getItem(GMAIL_DENSITY_INTENT_KEY);
  assert.equal(h.intent().pending, true);
  assert.ok(h.storage.length <= 37, `bounded cache, observed ${h.storage.length} keys`);
  const reload = h.page();
  reload.persistence.retry(); void reload.persistence.flush(); await settle();
  assert.equal(h.storage.getItem(GMAIL_DENSITY_INTENT_KEY), latest);
  h.requests.at(-1).commit(); await settle();
  assert.equal(h.intent().pending, false);
  assert.equal(h.server.gmailDensity, 'default');
});

test('plain-HTTP LAN environments generate distinct intent tokens without crypto.randomUUID', () => {
  const uuid = globalThis.crypto.randomUUID;
  globalThis.crypto.randomUUID = undefined;
  try {
    const h = harness();
    const { persistence } = h.page();
    persistence.choose('compact');
    const first = h.intent().token;
    persistence.choose('comfortable');
    assert.match(h.intent().token, /^[a-f0-9]{32}$/);
    assert.notEqual(h.intent().token, first);
  } finally { globalThis.crypto.randomUUID = uuid; }
});
