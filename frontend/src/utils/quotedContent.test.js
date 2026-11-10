import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { installQuotedContent, splitQuotedText } from './quotedContent.js';
import { buildFrameDoc } from './emailFrameDoc.js';

const rootFor = html => new JSDOM(`<div id="root">${html}</div>`).window.document.getElementById('root');
test('HTML quotes collapse only outer markers, preserve original nodes and restore exactly', () => {
  const root = rootFor('<p>New reply</p><div class="gmail_quote"><p>Old reply</p><blockquote>Nested</blockquote></div><blockquote>Other quote</blockquote>');
  const original = root.innerHTML;
  const quote = root.querySelector('.gmail_quote');
  const cleanup = installQuotedContent(root, { label: 'Quoted content' });
  const disclosures = root.querySelectorAll('details');
  assert.equal(disclosures.length, 2);
  assert.equal(disclosures[0].open, false);
  assert.equal(disclosures[0].querySelector('.gmail_quote'), quote);
  assert.equal(disclosures[0].querySelector('summary').textContent, 'Quoted content');
  disclosures[0].open = true;
  assert.ok(root.textContent.includes('Nested'));
  disclosures[0].open = false;
  cleanup();
  assert.equal(root.innerHTML, original);
});
test('quote-only, no-match, style-only prefix and existing disclosure messages stay unchanged', () => {
  for (const html of ['<p>Hello</p>', '<blockquote>Only a quotation</blockquote>', '<style>.x { color:red }</style><div class="gmail_quote">Only a quote</div>', '<p>Hello</p><details><summary>Already hidden</summary><blockquote>Quote</blockquote></details>']) {
    const root = rootFor(html), original = root.innerHTML;
    installQuotedContent(root);
    assert.equal(root.innerHTML, original);
  }
});
test('quote transform does not alter iframe security, URLs or sanitized original body', () => {
  const html = '<p>Hello</p><blockquote><img data-mailflow-src="/api/image/proxy?image=1"><a href="https://example.invalid">Old link</a></blockquote>';
  const source = buildFrameDoc({ html, remoteImagesBlocked: true, docKey: '123' });
  const doc = new JSDOM(source).window.document;
  const policy = doc.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
  installQuotedContent(doc.getElementById('mf-scale-wrapper'));
  assert.equal(doc.querySelector('meta[http-equiv="Content-Security-Policy"]').content, policy);
  assert.match(policy, /script-src 'none'/);
  assert.equal(doc.querySelectorAll('script').length, 0);
  assert.equal(doc.querySelector('img').hasAttribute('src'), false);
  assert.equal(doc.querySelector('a').getAttribute('href'), 'https://example.invalid');
  assert.equal(buildFrameDoc({ html, remoteImagesBlocked: true, docKey: '123' }), source);
});
test('plain text recognizes nested quote runs without swallowing inline answers or quote-only mail', () => {
  const text = 'Hello\n\n> old\n>> older\n\nMy inline answer\n> second question\n';
  const parts = splitQuotedText(text);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.equal(parts.filter(part => part.quoted).length, 2);
  assert.ok(parts.find(part => part.text.includes('My inline answer') && !part.quoted));
  assert.deepEqual(splitQuotedText('> only quote\n>> nested'), [{ text: '> only quote\n>> nested', quoted: false }]);
  assert.deepEqual(splitQuotedText('2 > 1\nNormal text'), [{ text: '2 > 1\nNormal text', quoted: false }]);
});
