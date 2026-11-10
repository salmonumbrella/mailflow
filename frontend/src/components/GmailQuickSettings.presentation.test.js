import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./GmailQuickSettings.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('./MailApp.jsx', import.meta.url), 'utf8');

test('quick-settings authored desktop geometry matches the reference without owning theme or font', () => {
  assert.match(css, /width: 320px; flex: 0 0 320px/);
  assert.match(css, /margin: 0 8px 16px 0; border-radius: 16px; overflow: auto/);
  assert.match(css, /padding: 12px 8px 12px 24px/);
  assert.match(css, /> section \{ padding: 20px 24px/);
  assert.match(css, /width: 18px; height: 18px/);
  assert.match(css, /background: var\(--bg-secondary\); color: var\(--text-primary\); font: inherit/);
  assert.doesNotMatch(css, /font-family:|background:\s*(?:white|#fff)\b/);
});

test('quick-settings authored overlay changes at 900px and retains viewport-safe width and keyboard outlines', () => {
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /position: fixed; right: 0; top: 64px; bottom: 0; z-index: 300/);
  assert.match(css, /width: min\(320px, calc\(100% - 8px\)\)/);
  assert.match(css, /:focus-visible \{ outline: 2px solid var\(--accent\); outline-offset: 2px/);
  assert.match(css, /@media \(forced-colors: active\)/);
});

test('one persistent settings host is a mail-body sibling after both responsive mail branches', () => {
  assert.equal((app.match(/<GmailSettingsHost\b/g) || []).length, 1);
  const bodyStart = app.indexOf('<div className="mailflow-mail-body"');
  const hostStart = app.indexOf('<GmailSettingsHost');
  assert.ok(hostStart > bodyStart);
  assert.match(app.slice(hostStart, hostStart + 200), /onShowShortcutHelp=\{\(\) => setShowShortcutHelp\(true\)\}/);
  assert.match(app.slice(hostStart, hostStart + 230), /<\/div>\s*<InboxReplyDraftObserver/);
});
