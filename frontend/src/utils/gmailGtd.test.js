import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGmailGtdSections, buildGtdActionSections, getGmailGtdPage } from './gmailGtd.js';
import { resolveGtdHotkeyTarget } from './gtdHotkeys.js';

const watch = { id: 'watch-copy', message_id: '<same>', account_id: 'a', is_read: false };
const delegated = { ...watch, id: 'delegated-copy' };
const sections = {
  watch: { total: 3, unread: 2, threads: [watch] },
  delegated: { total: 4, unread: 1, threads: [delegated] },
  waiting: { total: 6, unread: 2 },
};

test('Gmail multiple inboxes preserve separate native state counts and objects', () => {
  const rows = buildGmailGtdSections(sections);
  assert.deepEqual(rows.map(s => s.key), ['todo', 'watch', 'delegated', 'reference', 'someday']);
  assert.equal(rows[1].total, 3);
  assert.equal(rows[2].total, 4);
  assert.equal(rows[1].threads[0], watch);
  assert.equal(rows[2].threads[0], delegated);
  assert.equal(buildGtdActionSections(sections).find(s => s.key === 'waiting').total, 6);
});

test('nine-row pages clamp after removals and disclose the bounded server feed', () => {
  const section = { total: 70, threads: Array.from({ length: 50 }, (_, id) => ({ id })) };
  const first = getGmailGtdPage(section);
  assert.equal(first.rows.length, 9);
  assert.equal(first.first, 1);
  assert.equal(first.last, 9);
  assert.equal(first.total, 70);
  assert.equal(first.bounded, true);
  const last = getGmailGtdPage(section, 100);
  assert.equal(last.page, 5);
  assert.equal(last.first, 46);
  assert.equal(last.last, 50);
  assert.equal(getGmailGtdPage({ threads: section.threads.slice(0, 8) }, 5).page, 0);
  assert.equal(getGmailGtdPage(null).first, 0);
});

for (const [key, row] of [['watch', watch], ['delegated', delegated]]) {
  test(`Gmail ${key} keyboard Done only clears the selected native state`, () => {
    const target = resolveGtdHotkeyTarget({
      selectedMessageId: row.id, enabledPlugins: ['gtd'],
      accounts: [{ id: 'a', gtd_enabled: true }], gtdSections: sections,
      messages: [], threadMessages: {}, activeGtdTab: null,
    }, { id: row.id, sectionKey: key });
    assert.equal(target.surface, 'rail');
    assert.deepEqual(target.states, [key]);
    assert.equal(target.message, row);
  });
}
