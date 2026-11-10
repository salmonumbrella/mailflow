import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createListKeyboardActionGuard } from './listKeyboardActionGuard.js';
const message = { id: 'm', account_id: 'a', uid: 1, folder: 'INBOX' };
function fixture() {
  let state = { user: { id: 'u' }, isLocked: false, accounts: [{ id: 'a', storage_generation: 'g' }], messages: [message], searchResults: [], threadMessages: {} };
  const listeners = new Set();
  const store = { getState: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, set: patch => { state = { ...state, ...patch }; listeners.forEach(fn => fn(state)); } };
  return { store, listeners };
}
for (const [field, changed] of [['user', { id: 'other' }], ['isLocked', true], ['accounts', [{ id: 'a', storage_generation: 'new' }]]]) {
  test(`a transient ${field} replacement invalidates keyboard work permanently`, () => {
    const { store, listeners } = fixture();
    const original = store.getState()[field];
    const guard = createListKeyboardActionGuard(store, [message]);
    store.set({ [field]: changed }); store.set({ [field]: original });
    assert.equal(guard.current(), false);
    guard.dispose(); assert.equal(listeners.size, 0);
  });
}
test('source/scope changes invalidate preparation, while frozen queued targets permit navigation/removal', () => {
  const { store } = fixture(); let scope = 0;
  const prepare = createListKeyboardActionGuard(store, [message], { scopeKey: () => scope, sourceKey: state => state.messages.map(m => m.id).join() });
  const queued = createListKeyboardActionGuard(store, [message]);
  store.set({ messages: [] }); scope++;
  assert.equal(prepare.current(), false); assert.equal(queued.current(), true);
  prepare.dispose(); queued.dispose();
});
