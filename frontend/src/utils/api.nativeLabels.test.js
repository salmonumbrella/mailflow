import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, CSRF_HEADER, CSRF_VALUE } from './api.js';

test('native label client uses independent endpoints, scoped bodies and CSRF protection', async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, ...options }); return new Response(JSON.stringify({ labels: [], treeRevision: '9007199254740999' }), { status: 200 }); };
  try {
    const accountId = 'account/one'; const id = 'label/one';
    const payload = { accountId, mutationId: 'request-id', expectedRevision: '9007199254740993' };
    const read = await api.getNativeLabels(accountId);
    await api.createNativeLabel(payload); await api.updateNativeLabel(id, payload);
    await api.previewNativeLabelDelete(id, accountId);
    await api.deleteNativeLabel(id, { ...payload, expectedTreeRevision: '9007199254740995', confirmSubtree: true });
    assert.equal(read.treeRevision, '9007199254740999');
    assert.deepEqual(calls.map(c => [c.method, c.url]), [['GET', '/api/labels?accountId=account%2Fone'], ['POST', '/api/labels'], ['PATCH', '/api/labels/label%2Fone'], ['POST', '/api/labels/label%2Fone/delete-preview'], ['DELETE', '/api/labels/label%2Fone']]);
    for (const call of calls) { assert.equal(call.headers[CSRF_HEADER], CSRF_VALUE); assert.equal(call.credentials, 'include'); }
    assert.deepEqual(JSON.parse(calls[3].body), { accountId });
    assert.equal(JSON.parse(calls[4].body).expectedTreeRevision, '9007199254740995');
  } finally { globalThis.fetch = original; }
});

test('native label conflicts retain HTTP status and server code for safe refresh', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Changed', code: 'stale_tree_revision' }), { status: 409 });
  try { await assert.rejects(api.deleteNativeLabel('label', {}), error => error.status === 409 && error.code === 'stale_tree_revision'); }
  finally { globalThis.fetch = original; }
});

test('memberships and feeds use exact native entity endpoints and preserve decimal versions', async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, ...options }); return new Response('{}', { status: 200 }); };
  try {
    const payload = { accountId: 'account-one', storageGeneration: 'generation-one', targets: [{ entityId: 'entity-one', expectedMetadataVersion: '9007199254740993' }], addLabelIds: ['label-one'], removeLabelIds: [], mutationId: 'request-one' };
    await api.queryNativeLabelMemberships(payload); await api.mutateNativeLabelMemberships(payload);
    await api.getNativeLabelMessages('label/one', { accountId: 'account-one', storageGeneration: 'generation-one', cursor: 'opaque+cursor', includeSpamTrash: false });
    await api.getNativeLabelCounts('account-one', 'generation-one');
    assert.equal(calls[0].url, '/api/labels/memberships/query'); assert.equal(calls[1].url, '/api/labels/memberships');
    assert.deepEqual(JSON.parse(calls[1].body), payload);
    assert.equal(calls[2].url, '/api/labels/label%2Fone/messages?accountId=account-one&storageGeneration=generation-one&cursor=opaque%2Bcursor&includeSpamTrash=false');
    assert.equal(calls[3].url, '/api/labels/counts?accountId=account-one&storageGeneration=generation-one');
    for (const call of calls) assert.equal(call.headers[CSRF_HEADER], CSRF_VALUE);
  } finally { globalThis.fetch = original; }
});

test('Undo posts only the durable original mutation reference to its dedicated endpoint', async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, ...options }); return new Response('{}', { status: 200 }); };
  try {
    const payload = { accountId: 'account-one', storageGeneration: 'generation-one', originalMutationId: 'forward-one', mutationId: 'undo-one' };
    await api.undoNativeLabelMemberships(payload);
    assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].url, '/api/labels/memberships/undo');
    assert.deepEqual(JSON.parse(calls[0].body), payload); assert.equal(calls[0].headers[CSRF_HEADER], CSRF_VALUE);
  } finally { globalThis.fetch = original; }
});
