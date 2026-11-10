import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertSnippetText, snippetContent, isSnippetShortcut } from './mailSnippets.js';

test('plain-text insertion keeps every existing character and places the caret after the snippet', () => {
  assert.deepEqual(insertSnippetText('Hello world', 'friend ', 6), { text: 'Hello friend world', cursor: 13 });
  assert.deepEqual(insertSnippetText('Hello', '!', 500), { text: 'Hello!', cursor: 6 });
});

test('rich insertion is editor JSON, not interpreted HTML, and preserves newlines', () => {
  assert.deepEqual(snippetContent('<img src=x onerror=alert(1)>\nThanks & goodbye'), [
    { type: 'text', text: '<img src=x onerror=alert(1)>' },
    { type: 'hardBreak' },
    { type: 'text', text: 'Thanks & goodbye' },
  ]);
});

test('snippet shortcut accepts Ctrl or Command and ignores IME, repeats, and other modifiers', () => {
  assert.equal(isSnippetShortcut({ key: ';', ctrlKey: true }), true);
  assert.equal(isSnippetShortcut({ key: ';', metaKey: true }), true);
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { altKey: true }, { shiftKey: true }, { metaKey: true }]) {
    assert.equal(isSnippetShortcut({ key: ';', ctrlKey: true, ...extra }), false);
  }
  assert.equal(isSnippetShortcut({ key: ';' }), false);
});

test('compose drafts use an optional subject distinct from the snippet label and escape HTML', async () => {
  const { snippetDraft } = await import('./mailSnippets.js');
  assert.deepEqual(snippetDraft({ title: 'Label only', body: '<b>Hello</b>\nNext' }, false), { subject: '', body: '<p>&lt;b&gt;Hello&lt;/b&gt;<br>Next</p>', bodyIsHtml: true });
  assert.deepEqual(snippetDraft({ title: 'Label', subject: 'Actual subject', body: '<b>Hello</b>' }, true), { subject: 'Actual subject', body: '<b>Hello</b>', bodyIsHtml: false });
});
