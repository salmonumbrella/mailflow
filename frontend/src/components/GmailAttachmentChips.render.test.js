import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: 'export const useTranslation = () => ({ t: (_key, fallback) => fallback });' };
    }
    if (url.endsWith('.jsx')) {
      const code = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url }).code;
      return { format: 'module', shortCircuit: true, source: code };
    }
    return nextLoad(url, context);
  },
});
const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const GmailAttachmentChips = (await import('./GmailAttachmentChips.jsx')).default;
const source = { messageId: '11111111-1111-4111-8111-111111111111', accountId: '22222222-2222-4222-8222-222222222222',
  storageGeneration: '33333333-3333-4333-8333-333333333333', entityId: '44444444-4444-4444-8444-444444444444',
  folder: 'INBOX', uidValidity: '9', uid: '3' };
const file = { part: '2', filename: 'Actual report.pdf', type: 'application/pdf', size: 2048 };
const row = (items = [file], metadata = {}) => ({ id: source.messageId, account_id: source.accountId,
  storage_generation: source.storageGeneration, entity_id: source.entityId, uid_validity: source.uidValidity,
  uid: 3, folder: source.folder, has_attachments: true,
  attachmentMetadata: { state: 'partial', scope: 'message', source, items, omittedCount: 0,
    providerComplete: false, inlineClassification: 'partial', sizeIsExact: false, ...metadata },
});
let root;
const container = document.getElementById('root');
let requests = [];
globalThis.fetch = async (...args) => { requests.push(args); throw new Error('No request is authorized by metadata display'); };
afterEach(async () => {
  if (root) await React.act(async () => root.unmount());
  root = null;
  assert.equal(requests.length, 0, 'rendering and interacting with metadata must never fetch a body or part');
  requests = [];
});
async function render(message = row(), density = 'default', wrapper = false) {
  if (!root) root = createRoot(container);
  const chips = React.createElement(GmailAttachmentChips, { message, density });
  await React.act(async () => root.render(wrapper
    ? React.createElement('div', { role: 'group', tabIndex: 0, 'data-row': '' }, chips) : chips));
}

test('renders real cached names as static, accessible per-message metadata, not previews or links', async () => {
  await render(row([file, { part: '3', filename: 'Photo.png', type: 'image/png', size: 0 },
    { part: '4', filename: 'Contract.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: null }]));
  const list = container.querySelector('ul');
  assert.ok(list);
  assert.equal(list.getAttribute('aria-label'), 'Cached attachments for this message only; details may be incomplete.');
  assert.deepEqual([...list.querySelectorAll('.mailflow-gmail-attachment-name')].map(node => node.textContent),
    ['Actual report.pdf', 'Photo.png', 'Contract.docx']);
  assert.equal(list.querySelectorAll('li').length, 3);
  assert.equal(list.querySelectorAll('a,button,[role="button"],[tabindex],img,iframe').length, 0);
  assert.equal(list.querySelectorAll('[aria-hidden="true"] svg').length, 3, 'icons are decorative');
  assert.equal(container.textContent.includes('2048'), false, 'advisory MIME sizes are not exact download sizes');
  for (const name of list.querySelectorAll('.mailflow-gmail-attachment-name')) {
    assert.equal(name.getAttribute('dir'), 'auto', 'filename direction stays isolated');
  }
});

test('density changes preserve the focused row while only Default displays chips', async () => {
  await render(row(), 'default', true);
  const parent = container.querySelector('[data-row]'); parent.focus();
  for (const density of ['comfortable', 'compact', 'unrecognized', undefined, 'default']) {
    await render(row(), density === undefined ? null : density, true);
    assert.equal(Boolean(container.querySelector('ul')), density === 'default');
    assert.equal(document.activeElement, parent);
  }
});

test('empty, invalid, unavailable or other-message metadata does not manufacture chips from a paperclip', async () => {
  for (const message of [undefined, { has_attachments: true }, row([], { state: 'unknown' }),
    row([file], { source: null }), { ...row(), id: 'sibling-row' }, { ...row(), account_id: 'another-account' },
    row([{ ...file, shownInline: true }]), row([{ ...file, filename: 'Meeting.ics' }])]) {
    await render(message ?? null);
    assert.equal(container.childElementCount, 0);
  }
});

test('escapes hostile names, cleans controls, bounds long names and exposes no remote URLs', async () => {
  const malicious = '<img src=x onerror=alert(1)>.pdf';
  const long = 'Very long '.repeat(45) + '.pdf';
  await render(row([{ ...file, filename: malicious, url: 'https://evil.invalid/a' },
    { ...file, part: '3', filename: long }, { ...file, part: '4', filename: 'name\u202E\u0000.png' }]));
  assert.equal(container.querySelector('img'), null);
  assert.deepEqual([...container.querySelectorAll('.mailflow-gmail-attachment-name')].map(node => node.textContent),
    [malicious, long, 'name.png']);
  assert.equal(container.querySelector('.mailflow-gmail-attachment-chip').getAttribute('title'), malicious);
  assert.equal(container.innerHTML.includes('https://evil.invalid'), false);
});

test('limits chips and labels omitted cache details without a fabricated more-file count', async () => {
  await render(row(Array.from({ length: 20 }, (_, i) => ({ ...file, part: String(i + 1) })), { omittedCount: 999 }));
  assert.equal(container.querySelectorAll('.mailflow-gmail-attachment-chip').length, 3);
  const more = container.querySelector('.mailflow-gmail-attachment-overflow');
  assert.equal(more.textContent, '…');
  assert.equal(more.getAttribute('aria-label'), 'Additional cached attachment details are not shown.');
  assert.equal(container.textContent.includes('999'), false);
  assert.equal(container.textContent.includes('+'), false);
});

test('refresh, pointer/keyboard events and replacement metadata cannot start attachment work', async () => {
  await render(row(), 'default', true);
  const chip = container.querySelector('.mailflow-gmail-attachment-chip');
  for (const type of ['mouseover', 'mouseenter', 'click', 'dblclick', 'contextmenu', 'scroll']) {
    await React.act(async () => chip.dispatchEvent(new window.MouseEvent(type, { bubbles: true })));
  }
  for (const key of ['Enter', ' ', 'ArrowDown']) {
    await React.act(async () => chip.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true })));
  }
  await render(row([{ ...file, filename: 'Replacement.pdf' }]), 'default', true);
  assert.equal(container.querySelector('.mailflow-gmail-attachment-name').textContent, 'Replacement.pdf');
  await render({ ...row(), uid: 4 }, 'default', true);
  assert.equal(container.querySelector('ul'), null);
});
