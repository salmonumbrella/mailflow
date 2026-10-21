import { test, describe, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export const I18nextProvider = ({ children }) => children ?? null;',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    const shimViteEnv = (code) => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    if (url.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const AdminPanel = (await import('./AdminPanel.jsx')).default;

const ACCOUNT = { id: 'acct', name: 'Mail', email_address: 'owner@synthetic.test', enabled: true,
  imap_host: 'imap.fastmail.com', auth_user: 'owner@synthetic.test', smtp_host: 'smtp.fastmail.com',
  fastmail_verification_supported: true, fastmail_api_token_configured: true, fastmail_config_revision: 'old' };
describe('Fastmail verification token settings', () => {
  let root, sent;
  before(() => { api.admin.getSettings = async () => ({ settings: {} }); api.getUnreadCounts = async () => ({}); });
  afterEach(() => React.act(async () => root.unmount()));
  const click = el => React.act(async () => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  async function open() {
    sent = [];
    api.updateAccount = async (_id, data) => { sent.push(data); return { ...ACCOUNT, fastmail_config_revision: 'new' }; };
    useStore.setState({ user: { id: 'user-1' }, accounts: [ACCOUNT], adminTab: 'accounts' });
    root = createRoot(document.getElementById('root'));
    await React.act(async () => root.render(React.createElement(AdminPanel)));
    await click(document.querySelector('button[title="common.edit"]'));
  }
  const save = () => click([...document.querySelectorAll('button')].find(b => b.textContent === 'admin.accounts.saveChanges'));
  const token = () => document.querySelector('input[aria-label="admin.accounts.fastmailVerification.token"]');
  test('configured token is never populated; unrelated save preserves it', async () => {
    await open(); assert.equal(token().type, 'password'); assert.equal(token().value, '');
    assert.ok(document.body.textContent.includes('admin.accounts.fastmailVerification.help'));
    await save(); assert.equal(Object.hasOwn(sent[0], 'fastmail_api_token'), false);
  });
  test('replacement is forwarded once and safe account revision updates', async () => {
    await open();
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(token(), 'synthetic-token');
      token().dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await save(); assert.equal(sent[0].fastmail_api_token, 'synthetic-token');
    assert.equal(useStore.getState().accounts[0].fastmail_config_revision, 'new');
    assert.equal(useStore.getState().accounts[0].fastmail_api_token, undefined);
  });
  test('explicit clear forwards an empty value', async () => {
    await open(); await click([...document.querySelectorAll('button')].find(b => b.textContent === 'admin.accounts.fastmailVerification.clear'));
    await save(); assert.equal(sent[0].fastmail_api_token, '');
  });
});
