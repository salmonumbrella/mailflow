import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { moveHiddenPaths } from '../utils/sidebar.js';
import { ACTION_DEFS, getEffectiveShortcuts } from '../utils/defaultShortcuts.js';
import SignatureLibraryEditor from './SignatureLibraryEditor.jsx';
import GmailLabelManager from './GmailLabelManager.jsx';
import './GmailSettings.css';

const TABS = [
  ['general', 'General'], ['labels', 'Labels'], [null, 'Inbox'], [null, 'Accounts'],
  ['filters', 'Filters and Blocked Addresses'], [null, 'Forwarding and POP/IMAP'],
  [null, 'Add-ons'], [null, 'Chat and Meet'], [null, 'Advanced'], [null, 'Offline'], [null, 'Themes'],
];
const ACTIONS = { mark_read: 'Mark as read', star: 'Star it', archive: 'Skip the Inbox (Archive it)', delete: 'Move to Trash', move: 'Move to label / folder', set_category: 'Categorize as', notify: 'Notify me' };
const DESTINATIONS = ['archive', 'delete', 'move'];
const FIELDS = { from: 'From', to: 'To', subject: 'Subject', body: 'Has the words', has_attachment: 'Has attachment', header: 'Header', read_status: 'Read status' };
const clone = value => JSON.parse(JSON.stringify(value));
function sameRuleValue(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) return left.length === right.length && left.every((value, index) => sameRuleValue(value, right[index]));
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.prototype.hasOwnProperty.call(right, key) && sameRuleValue(left[key], right[key]));
}
// Use the exact server projection after both saves and reads (including recovery from a
// lost save response). Otherwise an unrelated edit in the legacy account form can restore
// stale signature fields from Zustand.
function applyLegacySignatureProjection(accountId, library) {
  if (!library.legacy) return;
  const current = useStore.getState();
  const source = current.accounts.find(a => a.id === accountId);
  if (!source) return;
  current.updateAccount(accountId, { signature: library.legacy.signature, signature_enabled: library.legacy.signature_enabled,
    aliases: (source.aliases || []).map(alias => ({ ...alias, signature: library.legacy.aliases.find(a => a.id === alias.id)?.signature ?? null })) });
}
const preferencesOf = state => ({ showMessagePreviews: state.showMessagePreviews, replyDefault: state.replyDefault, pageSize: state.pageSize, shortcuts: clone(state.shortcuts || {}) });

function Row({ title, children, note }) {
  return <section className="mf-gmail-settings-row"><div><strong>{title}:</strong>{note && <small>{note}</small>}</div><div>{children}</div></section>;
}
function Choice({ name, value, selected, onChange, children, disabled = false }) {
  return <label className="mf-gmail-settings-choice"><input type="radio" name={name} checked={selected === value} onChange={() => onChange(value)} disabled={disabled} />{children}</label>;
}

export default function GmailSettings({ onClose, initialAccountId, initialTab = 'general', initialCreateLabel = false, restoreFocus = true }) {
  const { t } = useTranslation();
  const state = useStore();
  const panel = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [tab, setTab] = useState(['general', 'labels', 'filters'].includes(initialTab) ? initialTab : 'general');
  const [prefs, setPrefs] = useState(() => preferencesOf(state));
  const [savedPrefs, setSavedPrefs] = useState(() => preferencesOf(state));
  const [signatures, setSignatures] = useState({});
  const [savedSignatures, setSavedSignatures] = useState({});
  const [accountId, setAccountId] = useState(initialAccountId || state.selectedAccountId || state.accounts[0]?.id || '');
  const [signatureLoad, setSignatureLoad] = useState(0);
  const [signatureError, setSignatureError] = useState('');
  const [busy, setBusy] = useState(false);
  const [labelLocked, setLabelLocked] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy || labelLocked;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [rules, setRules] = useState(null);
  const [loadState, setLoadState] = useState('');
  const [reload, setReload] = useState(0);
  const [folderForm, setFolderForm] = useState(null);
  const [ruleForm, setRuleForm] = useState(null);
  const [deleteRule, setDeleteRule] = useState(null);
  const [pendingRule, setPendingRule] = useState(null);
  const [deleteFolder, setDeleteFolder] = useState(null);
  const dirty = JSON.stringify(prefs) !== JSON.stringify(savedPrefs) || JSON.stringify(signatures) !== JSON.stringify(savedSignatures);
  const patchPref = (key, value) => setPrefs(p => ({ ...p, [key]: value }));
  const account = state.accounts.find(a => a.id === accountId);
  const folders = state.folders[accountId] || [];
  const signature = signatures[accountId];
  const shortcutsOn = Object.values(getEffectiveShortcuts(prefs.shortcuts, 'gmail')).some(Boolean);

  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.querySelector('button')?.focus();
    const onKey = event => {
      if (event.key === 'Escape') {
        if (panel.current?.querySelector('.mf-signature-library [data-signature-editor]')?.contains(event.target)) return;
        const labelEditor = panel.current?.querySelector('.mf-native-labels [data-label-editor]');
        if (labelEditor && labelEditor.closest('.mf-native-labels')?.contains(event.target)) return;
        event.preventDefault(); event.stopPropagation();
        if (!busyRef.current) closeRef.current();
      }
      if (event.key !== 'Tab') return;
      const elements = [...panel.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex="0"]')]
        .filter(el => !el.hidden && el.getAttribute('tabindex') !== '-1');
      const first = elements[0]; const last = elements.at(-1);
      if (!first) { event.preventDefault(); panel.current.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !panel.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); if (restoreFocus && previous?.isConnected) previous.focus(); };
  }, [restoreFocus]);

  useEffect(() => {
    let cancelled = false;
    if (tab === 'general' || (tab === 'labels' && !accountId)) return;
    setLoadState('loading'); setError('');
    const request = tab === 'filters' ? api.getRules() : api.getFolders(accountId);
    request.then(data => {
      if (cancelled) return;
      if (tab === 'filters') setRules(data);
      else useStore.getState().setFolders(accountId, data);
      setLoadState('ready');
    }).catch(err => { if (!cancelled) { setError(err.message || 'Settings could not be loaded.'); setLoadState('error'); } });
    return () => { cancelled = true; };
  }, [tab, accountId, reload]);

  useEffect(() => {
    const id = ruleForm?.accountId;
    if (!id || useStore.getState().folders[id]) return;
    let cancelled = false;
    api.getFolders(id).then(data => { if (!cancelled) useStore.getState().setFolders(id, data); })
      .catch(err => { if (!cancelled) setError(err.message || 'Could not load destination folders.'); });
    return () => { cancelled = true; };
  }, [ruleForm?.accountId]);

  useEffect(() => {
    if (!accountId || signatures[accountId]) return;
    let cancelled = false; setSignatureError('');
    api.getSignatureLibrary(accountId).then(data => {
      if (!Array.isArray(data.signatures) || !Array.isArray(data.defaults)) throw new Error(t('signatureLibrary.loadFailed', 'Signatures could not be loaded.'));
      if (cancelled) return;
      applyLegacySignatureProjection(accountId, data);
      setSignatures(previous => ({ ...previous, [accountId]: data }));
      setSavedSignatures(previous => ({ ...previous, [accountId]: clone(data) }));
    }).catch(err => { if (!cancelled) setSignatureError(err.message); });
    return () => { cancelled = true; };
  }, [accountId, signatureLoad]); // eslint-disable-line react-hooks/exhaustive-deps -- do not reload over unsaved edits

  async function run(action) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (err) { setError(err.message || 'The change could not be saved. Please try again.'); }
    finally { setBusy(false); }
  }

  async function saveGeneral() {
    await run(async () => {
      // Commit only changed keys. Theme, layout and font are deliberately untouched.
      const patch = Object.fromEntries(Object.entries(prefs).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(savedPrefs[key])));
      if (Object.keys(patch).length) {
        await api.savePreferences(patch);
        const current = useStore.getState();
        if ('showMessagePreviews' in patch) current.setShowMessagePreviews(patch.showMessagePreviews);
        if ('replyDefault' in patch) current.setReplyDefault(patch.replyDefault);
        if ('pageSize' in patch) current.setPageSize(patch.pageSize);
        if ('shortcuts' in patch) current.setShortcuts(patch.shortcuts);
        setSavedPrefs(clone(prefs));
      }
      for (const [id, draft] of Object.entries(signatures)) {
        if (JSON.stringify(draft) === JSON.stringify(savedSignatures[id])) continue;
        const updated = await api.saveSignatureLibrary(id, draft);
        setSignatures(previous => ({ ...previous, [id]: updated }));
        setSavedSignatures(previous => ({ ...previous, [id]: clone(updated) }));
        applyLegacySignatureProjection(id, updated);
        window.dispatchEvent(new CustomEvent('mailflow:signatures-changed', { detail: { accountId: id } }));
      }
      setNotice('Changes saved.');
    });
  }

  function changeTab(next) {
    setTab(next); setError(''); setNotice(''); setFolderForm(null); setRuleForm(null); setDeleteRule(null); setDeleteFolder(null);
  }
  function tabKeys(event) {
    if (labelLocked) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const enabled = ['general', 'labels', 'filters'];
    const index = enabled.indexOf(tab);
    const next = event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1) : enabled[(index + (event.key === 'ArrowRight' ? 1 : 2)) % 3];
    changeTab(next); panel.current.querySelector(`#mf-settings-tab-${next}`)?.focus();
  }
  async function visibility(path, hidden) {
    await run(async () => {
      const current = useStore.getState().hiddenFolders;
      const paths = current[accountId] || [];
      const next = { ...current, [accountId]: hidden ? [...new Set([...paths, path])] : paths.filter(p => p !== path) };
      await api.savePreferences({ hiddenFolders: next });
      useStore.setState({ hiddenFolders: next });
    });
  }
  async function saveFolder(event) {
    event.preventDefault();
    if (!folderForm.name.trim()) { setError(t('gmail.nativeLabels.folderNameRequired', 'Enter a folder name.')); return; }
    await run(async () => {
      let renamed;
      if (folderForm.path) renamed = await api.renameFolder(accountId, folderForm.path, folderForm.name.trim());
      else await api.createFolder(accountId, folderForm.name.trim(), folderForm.parentPath || undefined);
      // The mutation succeeded. Close its form before refreshing so a failed refresh cannot duplicate it.
      setFolderForm(null);
      if (renamed?.newPath) {
        const current = useStore.getState();
        const previousFolders = current.folders[accountId] || [];
        const hidden = current.hiddenFolders[accountId] || [];
        const moved = moveHiddenPaths(hidden, folderForm.path, renamed.newPath, previousFolders);
        const selected = moveHiddenPaths([current.selectedFolder], folderForm.path, renamed.newPath, previousFolders)[0];
        if (current.selectedAccountId === accountId && selected !== current.selectedFolder) current.setSelectedAccount(accountId, selected);
        if (JSON.stringify(hidden) !== JSON.stringify(moved)) {
          const next = { ...current.hiddenFolders, [accountId]: moved };
          // The server rename already happened: keep local paths correct even if saving visibility fails.
          useStore.setState({ hiddenFolders: next });
          try { await api.savePreferences({ hiddenFolders: next }); }
          catch (err) {
            current.setFolders(accountId, await api.getFolders(accountId));
            throw new Error(t('gmail.nativeLabels.folderRenamedError', 'Folder renamed, but sidebar visibility could not be saved: {{error}}', { error: err.message }), { cause: err });
          }
        }
      }
      useStore.getState().setFolders(accountId, await api.getFolders(accountId));
      setNotice(t('gmail.nativeLabels.folderSaved', 'Folder saved on your mail server.'));
    });
  }
  function openRule(rule) {
    setDeleteRule(null);
    setRuleForm(rule ? { id: rule.id, name: rule.name, accountId: rule.account_id || '', conditionLogic: rule.condition_logic || 'AND', conditions: clone(rule.conditions || []), actions: clone(rule.actions || []), enabled: rule.enabled, stopProcessing: rule.stop_processing } : {
      name: '', accountId: accountId || '', conditionLogic: 'AND', conditions: [{ field: 'from', operator: 'contains', value: '' }], actions: [], enabled: true, stopProcessing: false,
    });
  }
  function toggleAction(type, checked) {
    setRuleForm(form => ({ ...form, actions: checked ? [...form.actions.filter(a => !DESTINATIONS.includes(type) || !DESTINATIONS.includes(a.type)), { type, value: '' }] : form.actions.filter(a => a.type !== type) }));
  }
  async function reconcileRule(pending) {
    const latest = await api.getRules();
    setRules(latest);
    const payload = pending.payload;
    const recovered = latest.find(rule => !pending.beforeIds.includes(rule.id)
      && rule.name === payload.name
      && (rule.account_id || null) === payload.accountId
      && (rule.condition_logic || 'AND') === payload.conditionLogic
      && sameRuleValue(rule.conditions, payload.conditions)
      && sameRuleValue(rule.actions, payload.actions)
      && (rule.enabled !== false) === payload.enabled
      && Boolean(rule.stop_processing) === Boolean(payload.stopProcessing));
    if (recovered) {
      setPendingRule(null); setRuleForm(null); setError('');
      setNotice('The filter was saved. Its saved record has been verified on the server.');
    } else {
      setPendingRule({ ...pending, checked: true });
      setError('The save outcome is still uncertain. No new matching filter was found. Check again before discarding this pending draft; discarding does not undo a filter that may have been saved.');
    }
  }
  async function saveRule(event) {
    event.preventDefault();
    if (pendingRule) return;
    const { id, ...payload } = ruleForm;
    payload.name = payload.name.trim();
    if (!payload.name || !payload.conditions.length || !payload.actions.length || payload.conditions.some(c => c.field !== 'has_attachment' && !String(c.value || '').trim())) {
      setError('Enter a name, at least one complete condition, and an action.'); return;
    }
    if (payload.actions.some(a => (a.type === 'move' && (!payload.accountId || !a.value)) || (a.type === 'set_category' && !a.value))) {
      setError('Choose an account and destination for moving mail, or a category for categorization.'); return;
    }
    await run(async () => {
      payload.accountId ||= null;
      let saved;
      try { saved = id ? await api.updateRule(id, payload) : await api.createRule(payload); }
      catch (err) {
        if (id || (err.status >= 400 && err.status < 500 && err.status !== 408)) throw err;
        const pending = { payload: clone(payload), beforeIds: (rules || []).map(rule => rule.id), checked: false };
        setPendingRule(pending);
        try { await reconcileRule(pending); }
        catch { throw new Error('The filter save outcome is unknown and the filter list could not be checked. Check save status before creating another filter.'); }
        return;
      }
      setRules(current => id ? current.map(r => r.id === id ? saved : r) : [...(current || []), saved]);
      setRuleForm(null); setNotice('Filter saved. It applies to incoming mail; existing mail has not been changed.');
    });
  }

  return <div className="mf-gmail-settings-backdrop">
    <section ref={panel} role="dialog" aria-modal="true" aria-labelledby="mf-gmail-settings-title" tabIndex={-1} className="mf-gmail-settings">
      <header className="mf-gmail-settings-header"><h1 id="mf-gmail-settings-title">{t("gmail.settings.settings", "Settings")}</h1><button type="button" onClick={onClose} disabled={busy || labelLocked} aria-label={t("gmail.settings.close_settings", "Close settings")}>×</button></header>
      <div role="tablist" aria-label={t("gmail.settings.settings", "Settings")} className="mf-gmail-settings-tabs" onKeyDown={tabKeys}>
        {TABS.map(([id, name]) => <button type="button" key={name} role="tab" id={id ? `mf-settings-tab-${id}` : undefined} aria-controls={id ? 'mf-settings-panel' : undefined} aria-selected={id === tab} tabIndex={id === tab ? 0 : -1} disabled={!id || busy || labelLocked} title={!id ? 'Not available in this settings view. Use MailFlow settings for account and appearance options.' : undefined} onClick={() => changeTab(id)}>{name}</button>)}
      </div>
      <div className="mf-gmail-settings-messages" aria-live="polite">
        {error && <div role="alert">{error}{loadState === 'error' && <button type="button" onClick={() => setReload(r => r + 1)}>{t("gmail.settings.retry", "Retry")}</button>}<button type="button" aria-label={t("gmail.settings.dismiss_error", "Dismiss error")} onClick={() => setError('')}>×</button></div>}
        {notice && <div role="status">{notice}<button type="button" aria-label={t("gmail.settings.dismiss_notice", "Dismiss notice")} onClick={() => setNotice('')}>×</button></div>}
      </div>
      <div className="mf-gmail-settings-scroll" id="mf-settings-panel" role="tabpanel" aria-labelledby={`mf-settings-tab-${tab}`}>
        <fieldset disabled={busy} className="mf-gmail-settings-fieldset">
          {tab === 'general' && <>
            <Row title={t("gmail.settings.maximum_page_size", "Maximum page size")}><label>{t("gmail.settings.show", "Show")} <select aria-label={t("gmail.settings.maximum_page_size", "Maximum page size")} value={prefs.pageSize} onChange={e => patchPref('pageSize', Number(e.target.value))}>{[10, 25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}</select> {t("gmail.settings.conversations_per_page", "conversations per page")}</label></Row>
            <Row title={t("gmail.settings.desktop_notifications", "Desktop notifications")}><p>{t("gmail.settings.mailflow_notification_delivery_is_managed_in_native_notification_settings", "MailFlow notification delivery is managed in native notification settings. Gmail important-mail-only notifications are unavailable here.")}</p><button type="button" onClick={() => setNotice('Open MailFlow settings → Notifications to manage desktop notification permissions and delivery.')}>{t("gmail.settings.learn_more", "Learn more")}</button></Row>
            <Row title={t("gmail.settings.stars", "Stars")}><span className="mf-gmail-settings-star" aria-label={t("gmail.settings.yellow_star", "Yellow star")}>★</span><p>{t("gmail.settings.mailflow_uses_one_star_flag_additional_star_colors_and", "MailFlow uses one star flag. Additional star colors and cycling presets are not supported by the mail backend.")}</p><button type="button" disabled>{t("gmail.settings.1_star", "1 star")}</button> <button type="button" disabled>{t("gmail.settings.4_stars", "4 stars")}</button> <button type="button" disabled>{t("gmail.settings.all_stars", "all stars")}</button></Row>
            <Row title={t("gmail.settings.keyboard_shortcuts", "Keyboard shortcuts")}>
              <Choice name="shortcuts" value={false} selected={shortcutsOn} onChange={() => patchPref('shortcuts', Object.fromEntries(Object.keys(ACTION_DEFS).map(key => [key, ''])))}>{t("gmail.settings.keyboard_shortcuts_off", "Keyboard shortcuts off")}</Choice>
              <Choice name="shortcuts" value={true} selected={shortcutsOn} onChange={() => patchPref('shortcuts', Object.values(getEffectiveShortcuts(savedPrefs.shortcuts, 'gmail')).some(Boolean) ? savedPrefs.shortcuts : {})}>{t("gmail.settings.keyboard_shortcuts_on", "Keyboard shortcuts on")}</Choice>
              <small>{t("gmail.settings.reenabling_shortcuts_after_saving_them_off_restores_mailflow_defaults", "Re-enabling shortcuts after saving them off restores MailFlow defaults. Customize individual keys in MailFlow settings.")}</small>
            </Row>
            <Row title={t("gmail.settings.button_labels", "Button labels")}><span>{t("gmail.settings.icons", "Icons")}</span><p>{t("gmail.settings.textonly_button_labels_are_not_supported_by_the_current", "Text-only button labels are not supported by the current layout.")}</p></Row>
            <Row title={t("gmail.settings.my_picture", "My picture")}><div className="mf-gmail-settings-profile"><span aria-label={t("gmail.settings.profile_initials", "Profile initials")}>{(state.user?.display_name || state.user?.username || 'M').slice(0, 1)}</span><p>{state.user?.display_name || state.user?.username || 'MailFlow profile'}<br />{t("gmail.settings.manage_your_mailflow_profile_from_the_account_menu_this", "Manage your MailFlow profile from the account menu. This does not change a Google profile.")}</p></div></Row>
            <Row title={t("gmail.settings.create_contacts_for_autocomplete", "Create contacts for auto-complete")}><p>{t("gmail.settings.recipient_suggestions_use_mailflow_contacts_gmails_other_contacts_setting", "Recipient suggestions use MailFlow contacts. Gmail’s “Other Contacts” setting is not available.")}</p></Row>
            <Row title={t("gmail.settings.signature", "Signature")} note={t("gmail.settings.appended_to_outgoing_messages_from_the_selected_account", "Appended to outgoing messages from the selected account.")}>
              {!state.accounts.length ? <p>{t("gmail.settings.connect_a_mail_account_to_set_a_signature", "Connect a mail account to set a signature.")}</p> : <>
                <label>{t("gmail.settings.signature_for", "Signature for")} <select aria-label={t("gmail.settings.signature_account", "Signature account")} value={accountId} onChange={e => setAccountId(e.target.value)}>{state.accounts.map(a => <option key={a.id} value={a.id}>{a.name || a.email_address}</option>)}</select></label>
                {!signature && !signatureError && <p role="status">{t('signatureLibrary.loading', 'Loading signatures…')}</p>}
                {signatureError && <p role="alert">{signatureError} <button type="button" onClick={() => setSignatureLoad(n => n + 1)}>{t('signatureLibrary.retry', 'Retry')}</button></p>}
                {signature && <button type="button" disabled={busy} onClick={() => {
                  if (JSON.stringify(signature) !== JSON.stringify(savedSignatures[accountId]) && !window.confirm(t('signatureLibrary.reloadConfirm', 'Discard unsaved signature changes and reload?'))) return;
                  setSignatures(current => { const next = { ...current }; delete next[accountId]; return next; });
                  setSavedSignatures(current => { const next = { ...current }; delete next[accountId]; return next; });
                  setSignatureLoad(n => n + 1);
                }}>{t('signatureLibrary.reload', 'Reload signatures')}</button>}
                {signature && <SignatureLibraryEditor key={`${accountId}:${savedSignatures[accountId]?.revision}`} account={account} value={signature} disabled={busy} onChange={value => setSignatures(current => ({ ...current, [accountId]: value }))} />}
              </>}
            </Row>
            <Row title={t("gmail.settings.default_reply_behavior", "Default reply behavior")}>{[['reply', 'Reply'], ['replyAll', 'Reply all']].map(([value, text]) => <Choice key={value} name="reply" value={value} selected={prefs.replyDefault} onChange={v => patchPref('replyDefault', v)}>{text}</Choice>)}</Row>
            <Row title={t("gmail.settings.personal_level_indicators", "Personal level indicators")}><p>{t("gmail.settings.gmail_personallevel_arrows_are_not_available_in_mailflow", "Gmail personal-level arrows are not available in MailFlow.")}</p></Row>
            <Row title={t("gmail.settings.snippets", "Snippets")}><Choice name="snippets" value={true} selected={prefs.showMessagePreviews} onChange={v => patchPref('showMessagePreviews', v)}>{t("gmail.settings.show_snippets", "Show snippets")}</Choice><Choice name="snippets" value={false} selected={prefs.showMessagePreviews} onChange={v => patchPref('showMessagePreviews', v)}>{t("gmail.settings.no_snippets", "No snippets")}</Choice></Row>
            <Row title={t("gmail.settings.vacation_responder", "Vacation responder")}><p>{t("gmail.settings.automatic_vacation_replies_are_not_supported_by_mailflow_configure", "Automatic vacation replies are not supported by MailFlow. Configure them with your email provider; no automatic replies will be sent from this view.")}</p><button type="button" disabled>{t("gmail.settings.vacation_responder_on", "Vacation responder on")}</button></Row>
          </>}
          {tab === 'labels' && <div className="mf-gmail-settings-labels">

            <label>{t("gmail.settings.account", "Account")} <select aria-label={t("gmail.settings.label_account", "Label account")} disabled={labelLocked} value={accountId} onChange={e => { setAccountId(e.target.value); setFolderForm(null); setDeleteFolder(null); }}>{state.accounts.map(a => <option key={a.id} value={a.id}>{a.name || a.email_address}</option>)}</select></label>
            {account && <GmailLabelManager key={accountId} accountId={accountId} initialCreate={initialCreateLabel && accountId === initialAccountId} onLockChange={setLabelLocked} />}
            <h2>{t('gmail.nativeLabels.foldersTitle', 'IMAP folders')}</h2>
            <p>{t('gmail.nativeLabels.foldersScope', 'These are folders on your mail server, not MailFlow labels. Folder changes apply immediately and deleting a folder can permanently delete its messages.')}</p>
            {!account && <p>{t("gmail.settings.connect_an_account_to_manage_labels", "Connect an account to manage labels.")}</p>}
            {loadState === 'loading' && <p role="status">{t("gmail.nativeLabels.loadingFolders", "Loading IMAP folders…")}</p>}
            <div className="mf-gmail-settings-table-wrap"><table><thead><tr><th>{t("gmail.nativeLabels.folderColumn", "Folders")}</th><th>{t("gmail.settings.show_in_label_list", "Show in label list")}</th><th>{t("gmail.settings.show_in_imap", "Show in IMAP")}</th><th>{t("gmail.settings.actions", "Actions")}</th></tr></thead><tbody>
              {folders.map(folder => {
                const hidden = (state.hiddenFolders[accountId] || []).includes(folder.path);
                const system = folder.path.toUpperCase() === 'INBOX' || !!folder.special_use || Object.values(account?.folder_mappings || {}).includes(folder.path);
                return <tr key={folder.path}><th scope="row"><span style={{ paddingInlineStart: `${Math.max(0, folder.path.split(folder.delimiter || '/').length - 1) * 12}px` }}>{folder.name || folder.path}</span><small>{folder.path}{folder.total_count != null ? ` · ${folder.total_count} messages` : ''}</small></th><td><button type="button" disabled={!hidden || folder.path.toUpperCase() === 'INBOX'} onClick={() => visibility(folder.path, false)} aria-label={`Show ${folder.path}`}>{t("gmail.settings.show", "show")}</button> <button type="button" disabled={hidden || folder.path.toUpperCase() === 'INBOX'} onClick={() => visibility(folder.path, true)} aria-label={`Hide ${folder.path}`}>{t("gmail.settings.hide", "hide")}</button></td><td><input type="checkbox" checked disabled aria-label={`${folder.path} is an IMAP folder`} /></td><td>{!system && <><button type="button" aria-label={`Edit ${folder.path}`} onClick={() => { setFolderForm({ path: folder.path, name: folder.name || folder.path }); setDeleteFolder(null); }}>{t("gmail.settings.edit", "edit")}</button> <button type="button" aria-label={`Remove ${folder.path}`} onClick={() => { setDeleteFolder(folder.path); setFolderForm(null); }}>{t("gmail.settings.remove", "remove")}</button></>}</td></tr>;
              })}
            </tbody></table></div>
            {account && loadState === 'ready' && !folders.length && <p>{t("gmail.settings.no_folders_found", "No folders found.")}</p>}
            <p>{t("gmail.settings.imap_visibility_and_categorymessagelist_visibility_cannot_be_changed_independently", "IMAP visibility and category/message-list visibility cannot be changed independently here. Hiding a folder only changes MailFlow’s sidebar.")}</p>
            <button type="button" disabled={!account} onClick={() => { setFolderForm({ name: '', parentPath: '' }); setDeleteFolder(null); }}>{t("gmail.nativeLabels.createFolder", "Create IMAP folder")}</button>
            {folderForm && <form onSubmit={saveFolder} className="mf-gmail-settings-editor"><h2>{folderForm.path ? t('gmail.nativeLabels.editFolder', 'Edit IMAP folder') : t('gmail.nativeLabels.newFolder', 'New IMAP folder')}</h2><label>{t("gmail.nativeLabels.folderName", "Folder name")}<input required maxLength={200} value={folderForm.name} onChange={e => setFolderForm(f => ({ ...f, name: e.target.value }))} /></label>{!folderForm.path && <label>{t("gmail.nativeLabels.nestFolder", "Nest folder under")}<select value={folderForm.parentPath} onChange={e => setFolderForm(f => ({ ...f, parentPath: e.target.value }))}><option value="">{t("gmail.settings.none", "None")}</option>{folders.map(f => <option key={f.path} value={f.path}>{f.path}</option>)}</select></label>}<div><button type="submit">{t("gmail.nativeLabels.saveFolder", "Save folder")}</button><button type="button" onClick={() => setFolderForm(null)}>{t("gmail.settings.cancel", "Cancel")}</button></div></form>}
            {deleteFolder && <div className="mf-gmail-settings-editor" role="alert"><h2>{t("gmail.settings.remove", "Remove")} {deleteFolder}?</h2><p>{t("gmail.settings.this_deletes_the_folder_on_your_mail_server_and", "This deletes the folder on your mail server and may permanently delete the messages it contains. This is not just hiding a Gmail label.")}</p><button type="button" onClick={() => run(async () => {
              await api.deleteFolder(accountId, deleteFolder);
              const current = useStore.getState();
              if (current.selectedAccountId === accountId && current.selectedFolder === deleteFolder) current.setSelectedAccount(accountId, 'INBOX');
              setDeleteFolder(null);
              const hidden = current.hiddenFolders[accountId] || [];
              const next = { ...current.hiddenFolders, [accountId]: moveHiddenPaths(hidden, deleteFolder, null, current.folders[accountId]) };
              if (JSON.stringify(hidden) !== JSON.stringify(next[accountId])) {
                useStore.setState({ hiddenFolders: next });
                await api.savePreferences({ hiddenFolders: next });
              }
              current.setFolders(accountId, await api.getFolders(accountId));
              setNotice('Folder removed from your mail server.');
            })}>{t("gmail.settings.delete_folder_and_its_contents", "Delete folder and its contents")}</button><button type="button" onClick={() => setDeleteFolder(null)}>{t("gmail.settings.cancel", "Cancel")}</button></div>}
          </div>}
          {tab === 'filters' && <div className="mf-gmail-settings-filters"><p>{t("gmail.settings.the_following_mailflow_filters_apply_to_incoming_mail_they", "The following MailFlow filters apply to incoming mail. They do not change Google account settings or the provider’s blocked-address list.")}</p>
            {loadState === 'loading' && <p role="status">{t("gmail.settings.loading_filters", "Loading filters…")}</p>}
            {loadState === 'ready' && !rules?.length && <p>{t("gmail.settings.you_have_no_filters", "You have no filters.")}</p>}
            <ul>{(rules || []).map(rule => <li key={rule.id}><div><strong>{rule.name}</strong>{!rule.enabled && ' (disabled)'}<br /><strong>{t("gmail.settings.matches", "Matches:")} </strong>{(rule.conditions || []).map(c => `${FIELDS[c.field] || c.field} ${c.field === 'has_attachment' ? '' : `${c.operator || ''} ${c.value || ''}`}`).join(` ${rule.condition_logic || 'AND'} `)}<br /><strong>{t("gmail.settings.do_this", "Do this:")} </strong>{(rule.actions || []).map(a => `${ACTIONS[a.type] || a.type}${a.value ? `: ${a.value}` : ''}`).join(', ')}</div><div><button type="button" aria-label={`Edit filter ${rule.name}`} onClick={() => openRule(rule)}>{t("gmail.settings.edit", "edit")}</button><button type="button" aria-label={`Delete filter ${rule.name}`} onClick={() => { setDeleteRule(rule); setRuleForm(null); }}>{t("gmail.settings.delete", "delete")}</button></div></li>)}</ul>
            <button type="button" disabled={loadState !== 'ready' || !!pendingRule} onClick={() => openRule()}>{t("gmail.settings.create_a_new_filter", "Create a new filter")}</button>
            {pendingRule && <div className="mf-gmail-settings-editor" role="status"><p>{t("gmail.settings.filter_creation_is_paused_until_its_save_outcome_is", "Filter creation is paused until its save outcome is checked.")}</p><button type="button" onClick={() => run(() => reconcileRule(pendingRule))}>{t("gmail.settings.check_filter_save", "Check filter save")}</button>{pendingRule.checked && <button type="button" onClick={() => { setPendingRule(null); setRuleForm(null); setError(''); setNotice('Pending draft discarded. This does not undo any filter already saved on the server.'); }}>{t("gmail.settings.discard_pending_draft", "Discard pending draft")}</button>}</div>}
            {deleteRule && <div role="alert" className="mf-gmail-settings-editor"><p>{t("gmail.settings.delete_filter", "Delete filter “")}{deleteRule.name}{t("gmail.settings.existing_messages_will_not_be_changed", "”? Existing messages will not be changed.")}</p><button type="button" onClick={() => run(async () => { await api.deleteRule(deleteRule.id); setRules(current => current.filter(r => r.id !== deleteRule.id)); setDeleteRule(null); setNotice('Filter deleted.'); })}>{t("gmail.settings.delete_filter", "Delete filter")}</button><button type="button" onClick={() => setDeleteRule(null)}>{t("gmail.settings.cancel", "Cancel")}</button></div>}
            {ruleForm && <form className="mf-gmail-settings-editor" onSubmit={saveRule}><h2>{ruleForm.id ? 'Edit filter' : 'Create filter'}</h2>
              <label>{t("gmail.settings.filter_name", "Filter name")}<input required value={ruleForm.name} onChange={e => setRuleForm(f => ({ ...f, name: e.target.value }))} /></label>
              <label>{t("gmail.settings.account", "Account")}<select value={ruleForm.accountId} onChange={e => setRuleForm(f => ({ ...f, accountId: e.target.value }))}><option value="">{t("gmail.settings.all_accounts", "All accounts")}</option>{state.accounts.map(a => <option key={a.id} value={a.id}>{a.name || a.email_address}</option>)}</select></label>
              <label>{t("gmail.settings.match", "Match")}<select value={ruleForm.conditionLogic} onChange={e => setRuleForm(f => ({ ...f, conditionLogic: e.target.value }))}><option value="AND">{t("gmail.settings.all_conditions", "All conditions")}</option><option value="OR">{t("gmail.settings.any_condition", "Any condition")}</option></select></label>
              {ruleForm.conditions.map((condition, index) => <div key={index} className="mf-gmail-settings-condition">
                <select aria-label={`Condition ${index + 1} field`} value={condition.field} onChange={e => setRuleForm(f => ({ ...f, conditions: f.conditions.map((c, i) => i === index ? { field: e.target.value, operator: 'contains', value: '' } : c) }))}>{Object.entries(FIELDS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
                {condition.field === 'header' && <input aria-label={`Condition ${index + 1} header`} placeholder={t("gmail.settings.header_name", "Header name")} value={condition.headerName || ''} onChange={e => setRuleForm(f => ({ ...f, conditions: f.conditions.map((c, i) => i === index ? { ...c, headerName: e.target.value } : c) }))} />}
                {!['has_attachment', 'read_status'].includes(condition.field) && <select aria-label={`Condition ${index + 1} operator`} value={condition.operator} onChange={e => setRuleForm(f => ({ ...f, conditions: f.conditions.map((c, i) => i === index ? { ...c, operator: e.target.value } : c) }))}>{['contains', 'not_contains', 'equals', 'starts_with', 'ends_with', 'regex'].map(v => <option key={v} value={v}>{v.replaceAll('_', ' ')}</option>)}</select>}
                {condition.field === 'read_status' ? <select aria-label={`Condition ${index + 1} value`} value={condition.value} onChange={e => setRuleForm(f => ({ ...f, conditions: f.conditions.map((c, i) => i === index ? { ...c, value: e.target.value } : c) }))}><option value="">{t("gmail.settings.choose_status", "Choose status")}</option><option value="read">{t("gmail.settings.read", "Read")}</option><option value="unread">{t("gmail.settings.unread", "Unread")}</option></select> : condition.field !== 'has_attachment' && <input required aria-label={`Condition ${index + 1} value`} value={condition.value || ''} onChange={e => setRuleForm(f => ({ ...f, conditions: f.conditions.map((c, i) => i === index ? { ...c, value: e.target.value } : c) }))} />}
                <button type="button" aria-label={`Remove condition ${index + 1}`} onClick={() => setRuleForm(f => ({ ...f, conditions: f.conditions.filter((_, i) => i !== index) }))}>×</button>
              </div>)}
              <button type="button" onClick={() => setRuleForm(f => ({ ...f, conditions: [...f.conditions, { field: 'from', operator: 'contains', value: '' }] }))}>{t("gmail.settings.add_condition", "Add condition")}</button><h3>{t("gmail.settings.do_this", "Do this:")}</h3>
              {Object.entries(ACTIONS).map(([type, label]) => <div key={type}><label className="mf-gmail-settings-choice"><input type="checkbox" checked={ruleForm.actions.some(a => a.type === type)} onChange={e => toggleAction(type, e.target.checked)} />{label}</label>{ruleForm.actions.some(a => a.type === type) && ['move', 'set_category'].includes(type) && <select aria-label={type === 'move' ? 'Destination folder' : 'Category'} value={ruleForm.actions.find(a => a.type === type).value} onChange={e => setRuleForm(f => ({ ...f, actions: f.actions.map(a => a.type === type ? { ...a, value: e.target.value } : a) }))}><option value="">{t("gmail.settings.choose", "Choose…")}</option>{(type === 'move' ? (state.folders[ruleForm.accountId] || []).map(f => [f.path, f.path]) : [['primary', 'Primary'], ['newsletter', 'Newsletters'], ['promotion', 'Promotions'], ['automated', 'Updates'], ['social', 'Social']]).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select>}</div>)}
              {ruleForm.actions.filter(a => !ACTIONS[a.type]).map((action, index) => <p key={index}>{t("gmail.settings.existing_action_preserved", "Existing action preserved:")} {action.type}{action.value ? `: ${action.value}` : ''}{t("gmail.settings.edit_this_action_in_mailflow_settings", ". Edit this action in MailFlow settings.")}</p>)}
              <label className="mf-gmail-settings-choice"><input type="checkbox" checked={ruleForm.enabled} onChange={e => setRuleForm(f => ({ ...f, enabled: e.target.checked }))} />{t("gmail.settings.enable_this_filter", "Enable this filter")}</label><label className="mf-gmail-settings-choice"><input type="checkbox" checked={ruleForm.stopProcessing} onChange={e => setRuleForm(f => ({ ...f, stopProcessing: e.target.checked }))} />{t("gmail.settings.stop_processing_other_filters_after_a_match", "Stop processing other filters after a match")}</label>
              <div><button type="submit" disabled={!!pendingRule}>{t("gmail.settings.save_filter", "Save filter")}</button><button type="button" onClick={() => setRuleForm(null)}>{t("gmail.settings.cancel", "Cancel")}</button></div>
            </form>}
          </div>}
        </fieldset>
      </div>
      <footer className="mf-gmail-settings-footer">{dirty && <span>{t("gmail.settings.unsaved_general_settings", "Unsaved general settings")}</span>}{tab === 'general' && <button type="button" disabled={!dirty || busy} onClick={saveGeneral}>{busy ? 'Saving…' : 'Save Changes'}</button>}<button type="button" disabled={busy || labelLocked} onClick={onClose}>{dirty ? 'Cancel' : 'Back to mail'}</button></footer>
    </section>
  </div>;
}
