import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { transform } from 'sucrase';
import { JSDOM } from 'jsdom';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: 'export const useTranslation = () => ({ t: key => key });' };
    }
    if (url.endsWith('.jsx')) {
      return { format: 'module', shortCircuit: true, source: transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic' }).code };
    }
    return nextLoad(url, context);
  },
});
const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { default: Indicator } = await import('./FastmailAddressIndicator.jsx');
const account = { id: 'a', enabled: true, email_address: 'primary@synthetic.test', fastmail_config_revision: 'revision', aliases: [{ email: 'alias@synthetic.test' }] };
const inventory = { accountId: 'a', provider: 'fastmail', configRevision: 'revision', identityStatus: 'ready', maskedStatus: 'ready', identities: [], maskedEmails: [{ email: 'mask@synthetic.test' }] };
function render(email, patch = {}) {
  const html = renderToStaticMarkup(React.createElement(Indicator, { account, inventory, email, ...patch }));
  return { html, document: new JSDOM(html).window.document };
}

test('masked and alias indicators have inline accessible names without tab stops', () => {
  for (const [email, key] of [['mask@synthetic.test', 'addressIndicator.masked'], ['alias@synthetic.test', 'addressIndicator.alias']]) {
    const { html, document } = render(email);
    const icon = document.querySelector('span[role="img"]');
    assert.ok(icon);
    assert.equal(icon.getAttribute('aria-label'), key);
    assert.equal(icon.getAttribute('title'), key);
    assert.ok(icon.querySelector('[aria-hidden="true"]'));
    assert.equal(document.querySelector('button, a, [tabindex]'), null);
    assert.ok(!html.includes(email), 'indicator labels never disclose addresses');
  }
});

test('primary, foreign and incomplete evidence render nothing', () => {
  assert.equal(render('primary@synthetic.test').html, '');
  assert.equal(render('external@synthetic.test').html, '');
  assert.equal(render('alias@synthetic.test', { inventory: { ...inventory, maskedStatus: 'unknown' } }).html, '');
  assert.equal(render('mask@synthetic.test', { inventory: { ...inventory, configRevision: null } }).html, '');
});

test('each recipient uses its email and account, independent of order or display name', () => {
  const recipients = ['mask@synthetic.test', 'external@synthetic.test', 'alias@synthetic.test'];
  const html = renderToStaticMarkup(React.createElement('div', null, recipients.map(email =>
    React.createElement('span', { key: email }, 'Display name', React.createElement(Indicator, { account, inventory, email })))));
  const document = new JSDOM(html).window.document;
  assert.deepEqual([...document.querySelectorAll('[role="img"]')].map(el => el.getAttribute('aria-label')), ['addressIndicator.masked', 'addressIndicator.alias']);
  assert.equal(render('mask@synthetic.test', { account: { ...account, id: 'b' } }).html, '');
});
