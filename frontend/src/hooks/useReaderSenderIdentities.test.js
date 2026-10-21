import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from '../utils/api.js';
import { useReaderSenderIdentities } from './useReaderSenderIdentities.js';

const dom = new JSDOM('<div id="root"></div>', { url: 'https://synthetic.test' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const account = { id: 'a', enabled: true, fastmail_verification_supported: true, fastmail_config_revision: 'r1' };
const result = (accountId = 'a', configRevision = 'r1') => ({ accountId, configRevision, provider: 'fastmail', maskedStatus: 'ready', identityStatus: 'ready', maskedEmails: [], identities: [] });

async function harness(t) {
  const calls = [];
  const previous = api.getSenderIdentities;
  api.getSenderIdentities = id => new Promise((resolve, reject) => calls.push({ id, resolve, reject }));
  const root = createRoot(document.getElementById('root'));
  let value;
  const renders = [];
  function Probe(props) {
    value = useReaderSenderIdentities(props);
    renders.push(value);
    return React.createElement('output', null, value?.accountId || 'unknown');
  }
  t.after(async () => {
    await act(async () => root.unmount());
    if (previous === undefined) delete api.getSenderIdentities;
    else api.getSenderIdentities = previous;
  });
  return {
    calls, renders, value: () => value,
    render: async (changes = {}) => act(async () => root.render(React.createElement(Probe, { userId: 'u1', account, configRevision: account.fastmail_config_revision, ...changes }))),
    resolve: async (i, response) => act(async () => calls[i].resolve(response)),
  };
}

test('ten same-account selections and account object polling share one display GET', async t => {
  const h = await harness(t);
  for (let message = 0; message < 10; message++) await h.render({ message, account: { ...account } });
  assert.equal(h.calls.length, 1);
  assert.equal(h.value(), undefined);
  await h.resolve(0, result());
  for (let message = 10; message < 20; message++) await h.render({ message, account: { ...account } });
  assert.equal(h.calls.length, 1);
  assert.equal(h.value().accountId, 'a');
});

test('switching accounts hides old state synchronously and ignores late responses', async t => {
  const h = await harness(t);
  await h.render();
  h.renders.length = 0;
  await h.render({ account: { ...account, id: 'b' } });
  assert.equal(h.calls.length, 2);
  assert.ok(h.renders.every(value => value === undefined));
  await h.resolve(1, result('b'));
  await h.resolve(0, result('a'));
  assert.equal(h.value().accountId, 'b');
});

test('returning to an account after switching away does not resurrect its old result', async t => {
  const h = await harness(t);
  await h.render();
  await h.resolve(0, result());
  await h.render({ account: { ...account, id: 'b' } });
  h.renders.length = 0;
  await h.render();
  assert.equal(h.calls.length, 3);
  assert.ok(h.renders.every(value => value === undefined));
  await h.resolve(1, result('b'));
  assert.equal(h.value(), undefined);
});

test('sign-out discards the memo and late completion; signing back in refetches', async t => {
  const h = await harness(t);
  await h.render();
  await h.render({ userId: null });
  await h.resolve(0, result());
  assert.equal(h.value(), undefined);
  await h.render();
  assert.equal(h.calls.length, 2);
});

test('replacement, clear and explicit refresh invalidate, unrelated changes do not', async t => {
  const h = await harness(t);
  await h.render();
  await h.resolve(0, result());
  await h.render({ account: { ...account, name: 'Renamed' } });
  assert.equal(h.calls.length, 1);
  await h.render({ configRevision: 'r2', account: { ...account, fastmail_config_revision: 'r2' } });
  assert.equal(h.value(), undefined);
  await h.resolve(1, result('a', 'r1'));
  assert.equal(h.value(), undefined, 'old echoed revision is rejected');
  await h.render({ configRevision: 'r3', account: { ...account, fastmail_config_revision: 'r3' } });
  await h.resolve(2, result('a', 'r3'));
  assert.equal(h.value().configRevision, 'r3');
  await h.render({ configRevision: 'r3', account: { ...account, fastmail_config_revision: 'r3' }, refreshKey: 1 });
  assert.equal(h.calls.length, 4);
  assert.equal(h.value(), undefined);
});

test('missing keys, disabled and unsupported accounts do not request or memoize', async t => {
  const h = await harness(t);
  for (const patch of [{ enabled: false }, { fastmail_verification_supported: false }, { fastmail_verification_supported: undefined }]) {
    await h.render({ account: { ...account, ...patch } });
  }
  await h.render({ configRevision: null });
  assert.equal(h.calls.length, 0);
  await h.render();
  await h.resolve(0, result('a', null));
  assert.equal(h.value(), undefined);
});

test('lookup failure stays unknown without retrying on message navigation', async t => {
  const h = await harness(t);
  await h.render();
  await act(async () => h.calls[0].reject(new Error('Unavailable')));
  await h.render({ message: 'next' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.value(), undefined);
});

test('a user switch cannot reuse the previous users display result', async t => {
  const h = await harness(t);
  await h.render();
  await h.resolve(0, result());
  h.renders.length = 0;
  await h.render({ userId: 'u2' });
  assert.equal(h.calls.length, 2);
  assert.ok(h.renders.every(value => value === undefined));
});


test('same-user session generation invalidates pending and settled reader evidence', async t => {
  const h = await harness(t);
  await h.render({ sessionGeneration: 1 });
  h.renders.length = 0;
  await h.render({ sessionGeneration: 2 });
  assert.equal(h.calls.length, 2);
  assert.ok(h.renders.every(value => value === undefined));
  await h.resolve(0, result());
  assert.equal(h.value(), undefined, 'prior-session response cannot populate the memo');
  await h.resolve(1, result());
  assert.equal(h.value().accountId, 'a');
  await h.render({ sessionGeneration: 2, message: 'next', account: { ...account } });
  assert.equal(h.calls.length, 2, 'stable-session navigation and polling still reuse one lookup');
  h.renders.length = 0;
  await h.render({ sessionGeneration: 3 });
  assert.ok(h.renders.every(value => value === undefined), 'settled prior-session evidence hides synchronously');
  assert.equal(h.calls.length, 3);
});

test('locking rejects a pending response and unlocking starts a new view memo', async t => {
  const h = await harness(t);
  await h.render({ sessionGeneration: 1 });
  await h.render({ sessionGeneration: 2, locked: true });
  await h.resolve(0, result());
  assert.equal(h.value(), undefined);
  assert.equal(h.calls.length, 1, 'locked view performs no lookup');
  await h.render({ sessionGeneration: 2, locked: false });
  assert.equal(h.calls.length, 2);
  await h.resolve(1, result());
  assert.equal(h.value().accountId, 'a');
});
