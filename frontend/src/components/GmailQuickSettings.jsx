import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { GMAIL_DENSITIES, normalizeGmailDensity } from '../utils/gmailDensity.js';
import './GmailQuickSettings.css';

const fieldNames = { from: 'From', to: 'To', subject: 'Subject', body: 'Has the words', has_attachment: 'Has attachment', header: 'Header', read_status: 'Read status', native_label: 'Label', is_read: 'Read' };
const actionNames = { mark_read: 'Mark as read', star: 'Star it', archive: 'Archive', delete: 'Move to Trash', move: 'Move to folder', set_category: 'Categorize as', notify: 'Notify me', forward: 'Forward to', apply_native_label: 'Apply label', remove_native_label: 'Remove label' };
const operators = { contains: ['admin.rules.opContains', 'contains'], not_contains: ['admin.rules.opNotContains', 'does not contain'], equals: ['admin.rules.opEquals', 'is exactly'], starts_with: ['admin.rules.opStartsWith', 'starts with'], ends_with: ['admin.rules.opEndsWith', 'ends with'], regex: ['admin.rules.opRegex', 'matches regex'], is: ['nativeLabelRules.convertedIs', 'Is'], is_not: ['nativeLabelRules.convertedIsNot', 'Is not'], has: ['nativeLabelRules.has', 'Has label'], not_has: ['nativeLabelRules.notHas', 'Does not have label'] };
const scopeOf = state => JSON.stringify([state.user?.id, state.isLocked, state.layout, state.selectedAccountId,
  state.nativeLabelsRevision, state.accounts.map(account => [account.id, account.enabled, account.storage_generation])]);

export default function GmailQuickSettings({ onClose, onShowShortcutHelp }) {
  const { t } = useTranslation();
  const state = useStore();
  const translate = useRef(t);
  translate.current = t;
  const panel = useRef(null);
  const cancelButton = useRef(null);
  const active = useRef(false);
  const epoch = useRef(0);
  const submitting = useRef(false);
  const invalidate = useCallback(() => { epoch.current += 1; }, []);
  const previousConfirmation = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [attempt, setAttempt] = useState(0);
  const [rules, setRules] = useState([]);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmation, setConfirmation] = useState(null);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const confirmationRef = useRef(null);
  confirmationRef.current = confirmation;
  const scopeName = rule => {
    if (!rule.account_id) return t('gmail.quick_settings.all_accounts', 'All accounts');
    const account = state.accounts.find(item => item.id === rule.account_id);
    return account ? [account.name, account.email_address].filter(Boolean).join(' · ') || account.id
      : t('gmail.quick_settings.unavailable_account', 'Unavailable account');
  };
  const fieldLabel = field => Object.hasOwn(fieldNames, field) ? t(`gmail.quick_settings.field_${field}`, fieldNames[field]) : field;
  const actionLabel = type => Object.hasOwn(actionNames, type) ? t(`gmail.quick_settings.action_${type}`, actionNames[type]) : type;
  const labelValue = (rule, id) => {
    const reference = rule.nativeLabelReferences?.find(item => item.id === id);
    return reference?.path || t('gmail.quick_settings.label_reference', { defaultValue: 'Label reference: {{id}}', id });
  };
  const conditionSummary = (rule, condition) => {
    const value = condition.field === 'native_label' ? labelValue(rule, condition.value)
      : condition.semantics === 'search_v1' && ['has_attachment', 'is_read'].includes(condition.field) && ['true', 'false'].includes(condition.value)
        ? t(condition.value === 'true' ? 'nativeLabelRules.convertedTrue' : 'nativeLabelRules.convertedFalse', condition.value === 'true' ? 'Yes' : 'No')
        : condition.field === 'read_status' && ['read', 'unread'].includes(condition.value)
          ? t(condition.value === 'read' ? 'admin.rules.readStatusRead' : 'admin.rules.readStatusUnread', condition.value === 'read' ? 'Is read' : 'Is unread') : condition.value ?? '';
    const header = condition.headerName ? ` (${condition.headerName})` : '';
    const operator = Object.hasOwn(operators, condition.operator) ? t(...operators[condition.operator]) : condition.operator || '';
    return `${condition.field === 'native_label' ? '' : fieldLabel(condition.field)}${header} ${operator} ${value}`.trim();
  };
  const actionSummary = (rule, action) => {
    const value = ['apply_native_label', 'remove_native_label'].includes(action.type) ? labelValue(rule, action.value) : action.value;
    return `${actionLabel(action.type)}${value ? `: ${value}` : ''}`;
  };
  const valid = useCallback((version, scope) => active.current && version === epoch.current && scope === scopeOf(useStore.getState()), []);

  useEffect(() => {
    active.current = true;
    panel.current?.querySelector('button')?.focus();
    const unsubscribe = useStore.subscribe((next, previous) => {
      if (scopeOf(next) === scopeOf(previous)) return;
      invalidate();
      submitting.current = false;
      setConfirmation(null); setPending(false); setUncertain(false); setRules([]); setStatus('loading'); setNotice('');
      setAttempt(value => value + 1);
    });
    return () => { active.current = false; invalidate(); unsubscribe(); };
  }, [invalidate]);

  useEffect(() => {
    const current = useStore.getState();
    if (!current.user || current.isLocked || current.layout !== 'gmail') return;
    const version = ++epoch.current;
    const scope = scopeOf(current);
    setStatus('loading'); setError('');
    api.getRules().then(data => {
      if (!valid(version, scope)) return;
      if (!Array.isArray(data)) throw new Error('Invalid rules response');
      setRules(data); setStatus('ready'); setUncertain(false); setConfirmation(null);
    }).catch(() => {
      if (valid(version, scope)) { setStatus('error'); setError(translate.current('gmail.quick_settings.load_failed', 'Filters could not be loaded. Try again.')); }
    });
    return invalidate;
  }, [attempt, valid, invalidate]);

  useEffect(() => {
    const previous = previousConfirmation.current;
    previousConfirmation.current = confirmation;
    if (confirmation) cancelButton.current?.focus();
    else if (previous && (document.activeElement === document.body || panel.current?.contains(document.activeElement))) {
      if (previous.opener?.isConnected) previous.opener.focus();
      else panel.current?.querySelector('button')?.focus();
    }
  }, [confirmation]);

  async function removeRule() {
    if (!active.current || !confirmation || confirmationRef.current !== confirmation || submitting.current || uncertain) return;
    const current = useStore.getState();
    if (!current.user || current.isLocked || current.layout !== 'gmail' || confirmation.context !== scopeOf(current) || confirmation.epoch !== epoch.current || !rules.some(rule => rule.id === confirmation.id)) return;
    const version = ++epoch.current;
    const scope = scopeOf(current);
    const id = confirmation.id;
    submitting.current = true; setPending(true); setError(''); setNotice('');
    try {
      await api.deleteRule(id);
      if (!valid(version, scope)) return;
      setRules(previous => previous.filter(rule => rule.id !== id)); setConfirmation(null);
      setNotice(t('gmail.quick_settings.deleted', 'Filter deleted. Existing messages were not changed.'));
    } catch {
      if (!valid(version, scope)) return;
      // A lost DELETE response is not evidence of failure. Read before offering another mutation.
      setUncertain(true);
      try {
        const latest = await api.getRules();
        if (!valid(version, scope)) return;
        if (!Array.isArray(latest)) throw new Error('Invalid rules response');
        setRules(latest); setConfirmation(null); setUncertain(false);
        if (latest.some(rule => rule.id === id)) setError(t('gmail.quick_settings.delete_not_confirmed', 'Deletion was not confirmed. Review the current filters before trying again.'));
        else setNotice(t('gmail.quick_settings.no_longer_exists', 'This filter no longer exists. Existing messages were not changed.'));
      } catch {
        if (valid(version, scope)) setError(t('gmail.quick_settings.delete_unknown', 'The deletion outcome is unknown. Refresh filters to check before trying again.'));
      }
    } finally {
      if (valid(version, scope)) { submitting.current = false; setPending(false); }
    }
  }

  const cancelConfirmation = () => {
    if (submitting.current || uncertain) return;
    confirmationRef.current = null;
    invalidate();
    setConfirmation(null);
  };
  const dismiss = () => {
    confirmationRef.current = null;
    invalidate();
    closeRef.current();
  };
  const openSettings = tab => window.dispatchEvent(new CustomEvent('mailflow:open-gmail-settings', { detail: { tab } }));
  const keys = event => {
    // This is a non-modal panel at every width: Tab may leave it, but mail shortcuts
    // must not run while operating its radios, selectors, or buttons.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      if (confirmationRef.current) cancelConfirmation();
      else dismiss();
    }
  };
  const busy = pending || uncertain;
  return <aside ref={panel} id="mailflow-gmail-quick-settings" className="mf-gmail-quick-settings" role="dialog" aria-modal="false" aria-labelledby="mf-gmail-quick-title" onKeyDown={keys}>
    <header><h2 id="mf-gmail-quick-title">{t('gmail.quick_settings.title', 'Quick settings')}</h2><button type="button" aria-label={t('gmail.quick_settings.close', 'Close quick settings')} onClick={dismiss}>×</button></header>
    <div className="mf-gmail-quick-all"><button type="button" disabled={busy} onClick={() => openSettings('general')}>{t('gmail.quick_settings.see_all', 'See all settings')}</button></div>
    <section><fieldset><legend>{t('gmail.quick_settings.density', 'Density')}</legend>{GMAIL_DENSITIES.map(value => <label key={value}><input type="radio" name="gmail-density" value={value} checked={normalizeGmailDensity(state.gmailDensity) === value} onChange={() => state.setGmailDensity(value)} />{t(`gmail.quick_settings.density_${value}`, value === 'default' ? 'Default' : value === 'comfortable' ? 'Comfortable' : 'Compact')}</label>)}</fieldset>
      <p className="mf-gmail-quick-note">{t('gmail.quick_settings.density_note', 'Default and Comfortable currently use the same row spacing. Attachment previews are not yet available.')}</p>
      <p className="mf-gmail-quick-note">{t('gmail.quick_settings.local_preferences', 'Preferences apply on this device immediately. Syncing them to your account requires a connection.')}</p>
      {state.gmailDensitySaveState === 'pending' && <p role="status">{t('gmail.quick_settings.density_pending', 'Syncing density to your account…')}</p>}
      {state.gmailDensitySaveState === 'failed' && <><p role="alert">{t('gmail.quick_settings.density_failed', 'Density is applied on this device, but could not be synced to your account.')}</p><button type="button" onClick={() => state.retryGmailDensitySave()}>{t('gmail.quick_settings.retry_density', 'Retry density sync')}</button></>}
    </section>
    <section><h3>{t('gmail.quick_settings.theme', 'Theme')}</h3><div className="mf-gmail-quick-theme" aria-hidden="true"><span /><span /><span /></div><p className="mf-gmail-quick-note">{t('gmail.quick_settings.theme_note', 'Using your selected MailFlow colors and font.')}</p></section>
    <section><label className="mf-gmail-quick-select" htmlFor="mf-gmail-quick-page-size">{state.scrollMode === 'infinite' ? t('gmail.quick_settings.fetch_size', 'Messages per load') : t('gmail.quick_settings.page_size', 'Messages per page')}</label><select id="mf-gmail-quick-page-size" value={state.pageSize} onChange={event => state.setPageSize(Number(event.target.value))}>{[10, 25, 50, 100].map(size => <option key={size} value={size}>{size}</option>)}</select>{state.scrollMode === 'infinite' && <p className="mf-gmail-quick-note">{t('gmail.quick_settings.infinite_note', 'Infinite scrolling stays on. This sets how many messages are fetched at a time.')}</p>}</section>
    <section><h3>{t('gmail.header.keyboard_shortcuts', 'Keyboard shortcuts')}</h3><button type="button" disabled={busy || !onShowShortcutHelp} onClick={onShowShortcutHelp}>{t('gmail.quick_settings.view_shortcuts', 'View shortcuts')}</button></section>
    <section aria-busy={status === 'loading' || pending}><h3>{t('gmail.quick_settings.filters', 'Saved filters')}</h3><button type="button" disabled={busy} onClick={() => openSettings('filters')}>{t('gmail.quick_settings.manage_filters', 'Manage filters')}</button>
      {status === 'loading' && <p role="status">{t('gmail.quick_settings.loading_filters', 'Loading filters…')}</p>}
      {error && <p role="alert">{error}</p>}
      {(status === 'error' || uncertain) && <button type="button" disabled={pending} onClick={() => setAttempt(value => value + 1)}>{t('gmail.quick_settings.refresh_filters', 'Refresh filters')}</button>}
      {notice && <p role="status">{notice}</p>}
      {status === 'ready' && !rules.length && <p>{t('gmail.settings.you_have_no_filters', 'You have no filters.')}</p>}
      {status === 'ready' && <ul className="mf-gmail-quick-rules">{rules.map(rule => <li key={rule.id}><div><strong>{rule.name}</strong><small>{scopeName(rule)}{rule.enabled === false && ` · ${t('gmail.quick_settings.disabled', 'Disabled')}`}</small><small>{(rule.conditions || []).map(condition => conditionSummary(rule, condition)).join(` ${rule.condition_logic || 'AND'} `)}</small><small>{(rule.actions || []).map(action => actionSummary(rule, action)).join(', ')}</small></div><button type="button" disabled={busy} aria-label={t('gmail.quick_settings.delete_named', { defaultValue: 'Delete filter {{name}} ({{scope}})', name: rule.name, scope: scopeName(rule) })} onClick={event => { setConfirmation({ ...rule, scope: scopeName(rule), context: scopeOf(state), epoch: epoch.current, opener: event.currentTarget }); setNotice(''); setError(''); }}>×</button></li>)}</ul>}
      {confirmation && <div className="mf-gmail-quick-confirm" role="alertdialog" aria-modal="false" aria-labelledby="mf-gmail-quick-delete-title" aria-describedby="mf-gmail-quick-delete-description"><strong id="mf-gmail-quick-delete-title">{t('gmail.quick_settings.confirm_delete', { defaultValue: 'Delete filter “{{name}}” for {{scope}}?', name: confirmation.name, scope: confirmation.scope })}</strong><p id="mf-gmail-quick-delete-description">{t('gmail.quick_settings.delete_note', 'Existing messages will not be changed.')}</p><button type="button" disabled={busy} onClick={removeRule}>{pending ? t('gmail.quick_settings.deleting', 'Checking deletion…') : t('gmail.quick_settings.delete', 'Delete filter')}</button><button ref={cancelButton} type="button" disabled={busy} onClick={cancelConfirmation}>{t('gmail.settings.cancel', 'Cancel')}</button></div>}
    </section>
  </aside>;
}
