import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import NativeRuleLabelSelect from './NativeRuleLabelSelect.jsx';
import { nativeRuleActionError } from '../utils/ruleActions.js';
import { GMAIL_SENDER_FILTER_EVENT, gmailSenderFilterDetails } from '../utils/gmailSenderFilter.js';
import { quoteSearch, refineSearchQuery, hasSearchRefinement, rememberSearch, searchFieldsToQuery, searchQueryToFields, searchQueryToRule } from '../utils/gmailSearch.js';

function SearchAddressInput({ value, onChange, inputRef, ...props }) {
  const id = useId();
  const [suggestions, setSuggestions] = useState([]);
  useEffect(() => {
    let cancelled = false;
    setSuggestions([]);
    if (value.trim().length < 2) return;
    const timer = setTimeout(() => {
      api.suggestContacts(value.trim()).then(result => {
        if (!cancelled) setSuggestions(result.contacts || []);
      }).catch(() => {});
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [value]);
  return <><input {...props} ref={inputRef} type="text" value={value} onChange={onChange} list={`${id}-addresses`} autoComplete="off"/><datalist id={`${id}-addresses`}>{suggestions.map((contact, index) => <option key={`${contact.email || contact.address}-${index}`} value={contact.email || contact.address}>{contact.name || contact.email || contact.address}</option>)}</datalist></>;
}

export default function GmailSearch({ query, onChange, inputRef }) {
  const { t } = useTranslation();
  const root = useRef(null);
  const localInput = useRef(null);
  const fieldInput = useRef(null);
  const input = inputRef || localInput;
  const id = useId();
  const userId = useStore(s => s.user?.id);
  const accountId = useStore(s => s.selectedAccountId);
  const folders = useStore(s => s.folders);
  const accounts = useStore(s => s.accounts);
  const historyKey = `mailflow:gmail-search-history:${userId || 'anonymous'}`;
  const [history, setHistory] = useState([]);
  const [open, setOpen] = useState(null);
  const [active, setActive] = useState(-1);
  const [fields, setFields] = useState(() => searchQueryToFields(query));
  const [contacts, setContacts] = useState([]);
  const [notice, setNotice] = useState('');
  const [senderScope, setSenderScope] = useState(null);
  const [filterQuery, setFilterQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [saveUncertain, setSaveUncertain] = useState(false);
  const [searchLabelAccount, setSearchLabelAccount] = useState(accountId || '');
  const [filterGeneration, setFilterGeneration] = useState(null);
  const [applyExisting, setApplyExisting] = useState(false);
  const [savedRuleId, setSavedRuleId] = useState(null);
  const [filterScope, setFilterScope] = useState({ accounts: [], scopeAccountId: null });
  const [filterAccountId, setFilterAccountId] = useState('');
  const [run, setRun] = useState(null);
  const runAttempt = useRef(null);
  const runStorageKey = `mailflow:filter-run:${userId || 'anonymous'}`;
  const userKey = useRef(runStorageKey);
  userKey.current = runStorageKey;
  const rememberRun = useCallback(next => { if (userKey.current !== runStorageKey) return; setRun(next); try { localStorage.setItem(runStorageKey, JSON.stringify(next)); } catch { /* Status still works in this tab. */ } }, [runStorageKey]);
  const checkRun = async current => {
    try { const status = await api.getRuleRun(current.ruleId, current.runId); rememberRun(status); return status; }
    catch (error) { const status = { ...current, status: current.status === 'pending_recovery' ? 'pending_recovery' : 'unknown', error: error.message }; rememberRun(status); return status; }
  };
  useEffect(() => {
    try { const stored = JSON.parse(localStorage.getItem(runStorageKey) || 'null'); setRun(stored?.runId && stored?.ruleId ? stored : null); } catch { setRun(null); }
    runAttempt.current = null;
  }, [runStorageKey]);
  useEffect(() => {
    if (!run || !['running', 'cancelling'].includes(run.status)) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try { const status = await api.getRuleRun(run.ruleId, run.runId); if (!cancelled) rememberRun(status); }
      catch (error) { if (!cancelled) rememberRun({ ...run, status: 'unknown', error: error.message }); }
    }, 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [run, rememberRun]);
  const stopRun = async () => {
    try { rememberRun(await api.cancelRuleRun(run.ruleId, run.runId)); }
    catch (error) { rememberRun({ ...run, status: 'unknown', error: error.message }); }
  };
  const [actions, setActions] = useState({ archive: false, mark_read: false, star: false, delete: false, category: '', move: '', apply_native_label: '', remove_native_label: '' });
  const [name, setName] = useState('');
  const suggestions = [
    ...history.filter(item => !query || item.toLowerCase().includes(query.toLowerCase())).map(value => ({ value, history: true })),
    ...contacts.map(contact => ({ value: `${query.toLowerCase().startsWith('to:') ? 'to' : 'from'}:${quoteSearch(contact.email || contact.address)}`, label: contact.name ? `${contact.name} <${contact.email || contact.address}>` : contact.email || contact.address })),
  ].slice(0, 10);
  const availableFolders = accountId ? (folders[accountId] || []) : Object.values(folders).flat();
  const folderPaths = [...new Set(availableFolders.filter(f => !f.no_select).map(f => f.path))];

  useEffect(() => {
    try { const stored = JSON.parse(localStorage.getItem(historyKey) || '[]'); setHistory(Array.isArray(stored) ? stored.filter(v => typeof v === 'string').slice(0, 10) : []); } catch { setHistory([]); }
  }, [historyKey]);
  useEffect(() => {
    if (!open) return;
    const outside = event => { if (!busy && !root.current?.contains(event.target)) setOpen(null); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, busy]);
  useEffect(() => {
    if (open === 'advanced') fieldInput.current?.focus();
    if (open === 'filter') root.current?.querySelector('.gmail-filter-dialog button')?.focus();
  }, [open]);
  useEffect(() => {
    let cancelled = false;
    const match = /^(?:from|to):([^\s]{2,})$/i.exec(query);
    setContacts([]);
    if (!match || open !== 'suggestions') return;
    const timer = setTimeout(() => api.suggestContacts(match[1]).then(result => { if (!cancelled) setContacts(result.contacts || []); }).catch(() => {}), 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, open]);

  const saveHistory = next => { setHistory(next); try { localStorage.setItem(historyKey, JSON.stringify(next)); } catch { /* Search still works without storage. */ } };
  const close = () => { setSenderScope(null); setOpen(null); input.current?.focus(); };
  const submit = value => { onChange(value); saveHistory(rememberSearch(history, value)); setOpen(null); input.current?.focus(); };
  const advanced = () => { setSearchLabelAccount(accountId || ''); setSenderScope(null); setFields(searchQueryToFields(query)); setNotice(''); setOpen('advanced'); };
  useEffect(() => {
    const openSenderFilter = event => {
      if (busy || event.defaultPrevented) return;
      const detail = event.detail;
      const state = useStore.getState();
      const verified = gmailSenderFilterDetails({ account_id: detail?.accountId, from_email: detail?.sender }, state);
      if (!verified || detail.userId !== verified.userId) return;
      setSenderScope({ accountId: verified.accountId, userId: verified.userId });
      setFields({ ...searchQueryToFields(''), from: verified.sender });
      setNotice(''); setOpen('advanced');
      event.preventDefault();
    };
    window.addEventListener(GMAIL_SENDER_FILTER_EVENT, openSenderFilter);
    return () => window.removeEventListener(GMAIL_SENDER_FILTER_EVENT, openSenderFilter);
  }, [busy]);
  const setField = (key, value) => setFields(current => ({ ...current, [key]: value }));
  const builtQuery = () => { try { return searchFieldsToQuery(fields, t); } catch (error) { setNotice(error.message); return null; } };
  const createFilter = () => {
    const value = builtQuery();
    if (!value) return;
    try {
      searchQueryToRule(value);
      const scopeAccountId = senderScope?.accountId || accountId || null;
      const displayed = accounts.filter(account => account.enabled !== false && (scopeAccountId ? account.id === scopeAccountId : account.include_in_unified_inbox !== false));
      if ((senderScope && senderScope.userId !== userId) || (scopeAccountId && !displayed.length)) throw new Error('The filter account is no longer available in this scope.');
      setFilterScope({ accounts: displayed, scopeAccountId, userId });
      setFilterAccountId(scopeAccountId || (displayed.length === 1 ? displayed[0].id : ''));
      setFilterGeneration(displayed.find(account => account.id === (scopeAccountId || (displayed.length === 1 ? displayed[0].id : '')))?.storage_generation || null);
      setSaveUncertain(false);
      runAttempt.current = null;
      setFilterQuery(value); setName(value); setApplyExisting(false); setSavedRuleId(null); setActions({ archive: false, mark_read: false, star: false, delete: false, category: '', move: '', apply_native_label: '', remove_native_label: '' }); setNotice(''); setOpen('filter'); }
    catch (error) { setNotice(error.message); }
  };
  const saveFilter = async event => {
    event.preventDefault();
    if (saving.current || busy || saveUncertain || (runAttempt.current && run?.runId === runAttempt.current)) return;
    const selected = ['archive', 'mark_read', 'star', 'delete'].filter(key => actions[key]).map(type => ({ type }));
    if (actions.category) selected.push({ type: 'set_category', value: actions.category });
    if (actions.move && filterAccountId) selected.push({ type: 'move', value: actions.move });
    for (const type of ['apply_native_label', 'remove_native_label']) if (actions[type]) selected.push({ type, value: actions[type] });
    selected.sort((a, b) => Number(['archive', 'delete', 'move'].includes(a.type)) - Number(['archive', 'delete', 'move'].includes(b.type)));
    if (!filterAccountId) { setNotice('Choose an account from this search for the filter.'); return; }
    // Recheck the captured scope at submission: account removal/disablement while this dialog
    // is open must not turn a message-specific filter into a unified or different-account rule.
    const current = useStore.getState();
    const liveAccount = current.accounts.find(account => account.id === filterAccountId && account.enabled !== false);
    if (current.user?.id !== filterScope.userId || !liveAccount
      || !filterScope.accounts.some(account => account.id === filterAccountId)
      || (filterScope.scopeAccountId ? filterScope.scopeAccountId !== filterAccountId : liveAccount.include_in_unified_inbox === false)) {
      setNotice('The filter account is no longer available in this scope.'); return;
    }
    const nativeError = nativeRuleActionError({ actions: selected, accountId: filterAccountId, expectedStorageGeneration: filterGeneration, accounts: current.accounts, snapshots: current.nativeLabelSnapshots });
    if (nativeError) { setNotice(t(nativeError)); return; }
    if (!selected.length) { setNotice('Select at least one filter action.'); return; }
    saving.current = true; setBusy(true); setNotice('');
    try {
      let ruleId = savedRuleId;
      if (!ruleId) {
        const rule = await api.createRule({ name: name.trim() || filterQuery, accountId: filterAccountId, expectedStorageGeneration: filterGeneration, searchScope: { accountIds: [filterAccountId], scopeAccountId: filterScope.scopeAccountId }, conditionLogic: 'AND', conditions: searchQueryToRule(filterQuery), actions: selected, enabled: true, stopProcessing: false });
        ruleId = rule.id;
        setSavedRuleId(ruleId);
      }
      if (applyExisting) {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
        const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
        const runId = runAttempt.current || `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        runAttempt.current = runId;
        try {
          const status = await api.runRule(ruleId, { accountIds: [filterAccountId], scopeAccountId: filterScope.scopeAccountId, runId });
          rememberRun(status);
        } catch (error) {
          if (error.status >= 400 && error.status < 500 && error.status !== 408) {
            setNotice(`Filter saved, but applying it to existing Inbox messages could not start: ${error.message || 'Try again.'}`);
          } else {
            await checkRun({ ruleId, runId, status: 'unknown' });
            setNotice('Filter saved. The run’s start could not be confirmed. Check its status or stop it; it will not be started again automatically.');
          }
          return;
        }
      }
      useStore.getState().addNotification({ title: 'Filter saved', body: applyExisting ? 'It will apply to new mail. The existing Inbox run has started; its result will appear when finished.' : 'It will apply to new incoming mail.' });
      close();
    } catch (error) {
      const uncertain = !savedRuleId && !(error.status >= 400 && error.status < 500 && error.status !== 408);
      if (uncertain) setSaveUncertain(true);
      setNotice(uncertain ? `${error.message || ''} ${t('nativeLabelRules.saveUncertain', { defaultValue: 'The save result is unknown. Check saved filters before creating another; no save or run was restarted.' })}` : error.message);
    } finally { saving.current = false; setBusy(false); }
  };

  return <div ref={root} className="mailflow-mail-search mailflow-gmail-search" onKeyDown={event => {
    if (event.key === 'Escape' && open && !busy) { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Tab' && (open === 'advanced' || open === 'filter')) {
      const dialog = root.current.querySelector('[role="dialog"]');
      const controls = [...dialog.querySelectorAll('input:not(:disabled), select:not(:disabled), button:not(:disabled)')];
      if (!controls.length) { event.preventDefault(); return; }
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <button type="button" className="gmail-search-icon" aria-label={t("gmailSearch.searchMail", { defaultValue: "Search mail" })} onClick={() => submit(query)}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/></svg></button>
    <input ref={input} type="text" role="combobox" aria-label={t("gmailSearch.searchMail", { defaultValue: "Search mail" })} placeholder={t("gmailSearch.searchMail", { defaultValue: "Search mail" })} aria-expanded={open === 'suggestions'} aria-controls={`${id}-suggestions`} aria-autocomplete="list" aria-activedescendant={open === 'suggestions' && active >= 0 && suggestions[active] ? `${id}-suggestion-${active}` : undefined} value={query}
      onFocus={() => { if (!open) setOpen('suggestions'); }} onChange={event => { onChange(event.target.value); setOpen('suggestions'); setActive(-1); }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen('suggestions'); setActive(current => suggestions.length ? (current + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length : -1); }
        if (event.key === 'Enter') { event.preventDefault(); submit(active >= 0 && suggestions[active] ? suggestions[active].value : query); }
      }} />
    {query && <button type="button" className="gmail-search-clear" aria-label={t('messageList.clearSearch')} onClick={() => { onChange(''); setActive(-1); input.current?.focus(); }}>×</button>}
    <button type="button" className="gmail-search-options" aria-label={t("gmailSearch.advancedSearchOptions", { defaultValue: "Advanced search options" })} aria-expanded={open === 'advanced'} onClick={open === 'advanced' ? close : advanced}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M3 6h18M3 12h18M3 18h18"/><circle cx="8" cy="6" r="2" fill="var(--bg-secondary)"/><circle cx="16" cy="12" r="2" fill="var(--bg-secondary)"/><circle cx="9" cy="18" r="2" fill="var(--bg-secondary)"/></svg></button>
    {run && !open && <div className="gmail-filter-run-status" role="status">
      <span>{run.status === 'running' ? 'Applying filter to existing Inbox messages…' : run.status === 'cancelling' ? 'Stopping after the current action…' : run.status === 'cancelled' ? 'Filter run stopped. Completed actions were not undone.' : run.status === 'completed' ? `Filter run finished: ${run.matched || 0} matched.` : run.status === 'pending_recovery' ? `Filter run ended with mailbox recovery pending: ${run.pendingCount || 1} messages. Some actions may already have completed. Do not rerun it until recovery is resolved.` : run.status === 'failed' ? 'Filter run had errors. Some actions may have completed.' : 'Filter run status is unavailable. No run was restarted.'}</span>
      {run.identityPending && run.status !== 'pending_recovery' && <span>Mailbox recovery is still pending for {run.pendingCount || 1} messages. Do not rerun completed actions.</span>}
      {['running', 'cancelling', 'unknown'].includes(run.status) && <button type="button" disabled={run.status === 'cancelling'} onClick={stopRun}>{t("gmailSearch.stopRun", { defaultValue: "Stop run" })}</button>}
      <button type="button" onClick={() => checkRun(run)}>{t("gmailSearch.checkStatus", { defaultValue: "Check status" })}</button>
      {!['running', 'cancelling'].includes(run.status) && <button type="button" onClick={() => { setRun(null); localStorage.removeItem(runStorageKey); }}>{t("gmailSearch.dismiss", { defaultValue: "Dismiss" })}</button>}
    </div>}
    {open === 'suggestions' && <div className="gmail-search-dropdown">
      <div className="gmail-search-chips">{[['Has attachment', 'has:attachment'], ['Last 7 days', `after:${new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)}`], ['Unread', 'is:unread']].map(([label, value]) => <button key={label} type="button" onClick={() => { const colon = value.indexOf(':'); submit(refineSearchQuery(query, value.slice(0, colon), value.slice(colon + 1))); }}>{label}</button>)}</div>
      <div id={`${id}-suggestions`} role="listbox" aria-label={t("gmailSearch.searchSuggestions", { defaultValue: "Search suggestions" })}>{suggestions.map((item, index) => <div key={`${item.value}-${index}`} className="gmail-search-suggestion" role="option" id={`${id}-suggestion-${index}`} aria-selected={active === index}>
        <button type="button" onClick={() => submit(item.value)}>{item.label || item.value}</button>
        {item.history && <button type="button" aria-label={`Remove recent search ${item.value}`} onClick={() => { saveHistory(history.filter(value => value !== item.value)); setActive(-1); }}>×</button>}
      </div>)}</div>
      <button type="button" className="gmail-search-advanced-link" onClick={advanced}>{t("gmailSearch.advancedSearch", { defaultValue: "Advanced search" })}</button>
    </div>}
    {open === 'advanced' && <form className="gmail-search-dropdown gmail-search-advanced" role="dialog" aria-label={t("gmailSearch.advancedSearch", { defaultValue: "Advanced search" })} onSubmit={event => { event.preventDefault(); const value = builtQuery(); if (value !== null) submit(value); }}>
      {[['from', 'From'], ['to', 'To'], ['subject', 'Subject'], ['words', 'Has the words'], ['without', "Doesn't have"]].map(([key, label]) => <label key={key}><span>{label}</span>{['from', 'to'].includes(key) ? <SearchAddressInput inputRef={key === 'from' ? fieldInput : undefined} value={fields[key]} onChange={event => setField(key, event.target.value)} /> : <input value={fields[key]} onChange={event => setField(key, event.target.value)} />}</label>)}
      <label><span>{t("gmailSearch.size", { defaultValue: "Size" })}</span><select aria-label={t("gmailSearch.sizeComparison", { defaultValue: "Size comparison" })} value={fields.sizeComparison} onChange={event => setField('sizeComparison', event.target.value)}><option value="larger">{t("gmailSearch.greaterThan", { defaultValue: "greater than" })}</option><option value="smaller">{t("gmailSearch.lessThan", { defaultValue: "less than" })}</option></select><input aria-label={t("gmailSearch.sizeValue", { defaultValue: "Size value" })} type="text" inputMode="decimal" value={fields.sizeValue} onChange={event => setField('sizeValue', event.target.value)}/><select aria-label={t("gmailSearch.sizeUnit", { defaultValue: "Size unit" })} value={fields.sizeUnit} onChange={event => setField('sizeUnit', event.target.value)}><option value="MB">{t("gmailSearch.mb", { defaultValue: "MB" })}</option><option value="KB">{t("gmailSearch.kb", { defaultValue: "KB" })}</option><option value="B">{t("gmailSearch.bytes", { defaultValue: "Bytes" })}</option></select></label>
      <p className="gmail-search-note">{t("gmailSearch.sizeUnitsHelp", { defaultValue: "Here, MB = 1,000,000 bytes and KB = 1,000 bytes. Typed K/KB, M/MB, and G/GB suffixes use powers of 1024. Size must resolve to whole bytes. Clear the amount to remove this size bound." })}</p>
      <p className="gmail-search-note">{t("gmailSearch.sizeCoverageHelp", { defaultValue: "Size searches use measured message sizes in the synchronized cache. Older or unsynchronized mail may be missing size data. This is not a search of all mail on your provider." })}</p>
      <label><span>{t("gmailSearch.dateWithin", { defaultValue: "Date within" })}</span><select aria-label={t("gmailSearch.dateWithin", { defaultValue: "Date within" })} value={fields.dateWithin} onChange={event => setField('dateWithin', event.target.value)}>{[['1', '1 day'], ['3', '3 days'], ['7', '1 week'], ['14', '2 weeks'], ['30', '1 month'], ['60', '2 months'], ['180', '6 months'], ['365', '1 year']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><input type="date" aria-label={t("gmailSearch.date", { defaultValue: "Date" })} value={fields.date} onChange={event => setField('date', event.target.value)} /></label>
      {!fields.date && (fields.after || fields.before) && <div className="gmail-search-date-bounds"><label>{t("gmailSearch.after", { defaultValue: "After" })}<input aria-label={t("gmailSearch.after", { defaultValue: "After" })} type="date" value={fields.after} onChange={event => setField('after', event.target.value)}/></label><label>{t("gmailSearch.before", { defaultValue: "Before" })}<input aria-label={t("gmailSearch.before", { defaultValue: "Before" })} type="date" value={fields.before} onChange={event => setField('before', event.target.value)}/></label></div>}
      <label><span>{t("gmailSearch.search", { defaultValue: "Search" })}</span><select aria-label={t("gmailSearch.searchFolder", { defaultValue: "Search folder" })} value={fields.folder} onChange={event => setField('folder', event.target.value)}><option value="">{t("gmailSearch.currentSearchScope", { defaultValue: "Current search scope" })}</option><option value="all">{t("gmailSearch.allMailExceptTrash", { defaultValue: "All Mail (except Trash)" })}</option>{folderPaths.map(path => <option key={path} value={path}>{path}</option>)}</select></label>
      <label><span>{t('nativeLabelRules.searchAccount', { defaultValue: 'Label account' })}</span><select aria-label={t('nativeLabelRules.searchAccount', { defaultValue: 'Label account' })} value={searchLabelAccount} onChange={event => { setSearchLabelAccount(event.target.value); setField('label', ''); }}><option value="">{t('gmailSearch.chooseAnAccount', { defaultValue: 'Choose an account…' })}</option>{accounts.filter(account => account.enabled !== false && (accountId ? account.id === accountId : account.include_in_unified_inbox !== false)).map(account => <option key={account.id} value={account.id}>{account.email_address || account.name || account.id}</option>)}</select></label>
      <label><span>{t('nativeLabelRules.searchLabel', { defaultValue: 'MailFlow label' })}</span><NativeRuleLabelSelect accountId={searchLabelAccount} value={fields.label} label={t('nativeLabelRules.searchLabel', { defaultValue: 'MailFlow label' })} onChange={value => setField('label', value)} /></label>
      <p className="gmail-search-note">{t('nativeLabelRules.searchHelp', { defaultValue: 'label: accepts a label ID, exact full path, or unique short name. Only direct membership matches. Ambiguous or missing labels are errors. In unified search, exclusions can include verified messages from other accounts. Unverified identities remain unknown.' })}</p>
      <label className="gmail-search-check"><input type="checkbox" checked={fields.attachment} onChange={event => setField('attachment', event.target.checked)} />{t("gmailSearch.hasAttachment", { defaultValue: "Has attachment" })}</label>
      {fields.extra && <label><span>{t("gmailSearch.otherTerms", { defaultValue: "Other terms" })}</span><input aria-label={t("gmailSearch.otherSearchTerms", { defaultValue: "Other search terms" })} value={fields.extra} onChange={event => setField('extra', event.target.value)} /></label>}
      <p className="gmail-search-note">{t("gmailSearch.supportedSearchOperatorsWithSize", { defaultValue: "MailFlow supports from:, to:, subject:, has:attachment, is:read/unread/starred, before:, after:, and in:. OR, AND, parentheses, curly-brace groups, filename:, category: and newer_than:/older_than: (d, m, y) are supported. Categories use MailFlow’s names. size: and larger: mean strictly greater than; smaller: means strictly less than. label: searches native MailFlow labels. Importance is not indexed. Attachment filenames and body text depend on synced content." })}</p>
      {notice && <p role="alert">{notice}</p>}
      <div className="gmail-search-actions"><button type="button" onClick={() => { close(); useStore.getState().setAdminTab('rules'); useStore.getState().setShowAdmin(true); }}>{t("gmailSearch.manageFilters", { defaultValue: "Manage filters" })}</button><button type="button" onClick={close}>{t("gmailSearch.cancel", { defaultValue: "Cancel" })}</button><button type="button" onClick={createFilter}>{t("gmailSearch.createFilter", { defaultValue: "Create filter" })}</button><button type="submit" className="gmail-search-primary">{t("gmailSearch.search", { defaultValue: "Search" })}</button></div>
    </form>}
    {open === 'filter' && <form className="gmail-search-dropdown gmail-filter-dialog" role="dialog" aria-label={t("gmailSearch.createFilter", { defaultValue: "Create filter" })} onSubmit={saveFilter}>
      <button type="button" disabled={busy || !!savedRuleId} onClick={() => { setNotice(''); setOpen('advanced'); }}>{t("gmailSearch.backToSearchOptions", { defaultValue: "‹ Back to search options" })}</button>
      <p>{t("gmailSearch.whenANewIncomingMessageMatches", { defaultValue: "When a new incoming message matches:" })}</p><p className="gmail-search-query">{filterQuery}</p>
      <fieldset disabled={busy || !!savedRuleId} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <label>{t("gmailSearch.filterAccount", { defaultValue: "Filter account" })}<select aria-label={t("gmailSearch.filterAccount", { defaultValue: "Filter account" })} value={filterAccountId} onChange={event => { setFilterAccountId(event.target.value); setFilterGeneration(filterScope.accounts.find(account => account.id === event.target.value)?.storage_generation || null); setActions(current => ({ ...current, move: '', apply_native_label: '', remove_native_label: '' })); }}><option value="">{t("gmailSearch.chooseAnAccount", { defaultValue: "Choose an account…" })}</option>{filterScope.accounts.map(account => <option key={account.id} value={account.id}>{account.email_address || account.name || account.id}</option>)}</select></label>
      <p className="gmail-search-note">{t("gmailSearch.thisFilterAppliesOnlyToTheSelectedAccountForBothNewMailAndAnyExistingMessageRun", { defaultValue: "This filter applies only to the selected account, for both new mail and any existing-message run." })}</p>
      <label>{t("gmailSearch.filterName", { defaultValue: "Filter name" })}<input value={name} onChange={event => setName(event.target.value)} /></label>
      {[['archive', 'Skip the Inbox (Archive it)'], ['mark_read', 'Mark as read'], ['star', 'Star it'], ['delete', 'Delete it']].map(([key, label]) => <label className="gmail-search-check" key={key}><input type="checkbox" checked={actions[key]} onChange={event => setActions(current => ({ ...current, [key]: event.target.checked, ...(event.target.checked && ['archive', 'delete'].includes(key) ? { [key === 'archive' ? 'delete' : 'archive']: false, move: '' } : {}) }))}/>{label}</label>)}
      <label>{t("gmailSearch.moveToFolder", { defaultValue: "Move to folder" })}<select aria-label={t("gmailSearch.filterDestination", { defaultValue: "Filter destination" })} disabled={!filterAccountId} value={actions.move} onChange={event => setActions(current => ({ ...current, move: event.target.value, archive: false, delete: false }))}><option value="">{t("gmailSearch.chooseFolder", { defaultValue: "Choose folder…" })}</option>{(folders[filterAccountId] || []).filter(folder => !folder.no_select).map(folder => <option key={folder.path} value={folder.path}>{folder.path}</option>)}</select></label>
      {!filterAccountId && <p className="gmail-search-note">{t("gmailSearch.selectAnAccountToMoveIncomingMailToAFolder", { defaultValue: "Select an account to move incoming mail to a folder." })}</p>}
      {['apply_native_label', 'remove_native_label'].map(type => <label key={type}><span>{type === 'apply_native_label' ? t('nativeLabelRules.apply', { defaultValue: 'Apply MailFlow label' }) : t('nativeLabelRules.remove', { defaultValue: 'Remove MailFlow label' })}</span><NativeRuleLabelSelect accountId={filterAccountId} value={actions[type]} label={type === 'apply_native_label' ? t('nativeLabelRules.apply', { defaultValue: 'Apply MailFlow label' }) : t('nativeLabelRules.remove', { defaultValue: 'Remove MailFlow label' })} onChange={value => setActions(current => ({ ...current, [type]: value }))} /></label>)}
      <label>{t("gmailSearch.categorizeAs", { defaultValue: "Categorize as" })}<select aria-label={t("gmailSearch.filterCategory", { defaultValue: "Filter category" })} value={actions.category} onChange={event => setActions(current => ({ ...current, category: event.target.value }))}><option value="">{t("gmailSearch.chooseCategory", { defaultValue: "Choose category…" })}</option>{['primary', 'newsletter', 'promotion', 'automated', 'social'].map(category => <option key={category} value={category}>{category}</option>)}</select></label>
      <label className="gmail-search-check"><input type="checkbox" checked={applyExisting} onChange={event => setApplyExisting(event.target.checked)}/>{t("gmailSearch.alsoApplyOnlyThisFilterToExistingMatchingInboxMessages", { defaultValue: "Also apply only this filter to existing matching Inbox messages" })}</label>
      </fieldset>
      <button type="button" disabled={busy} onClick={() => { close(); useStore.getState().setAdminTab('rules'); useStore.getState().setShowAdmin(true); }}>{t("gmailSearch.manageSavedFiltersInMailFlowRules", { defaultValue: "Manage saved filters in MailFlow Rules" })}</button>
      <p className="gmail-search-note">{t("gmailSearch.existingMessageRunsCoverTheInboxOnlyAndDoNotRunYourOtherFiltersLabelsImportanceAndNeverSpamAreNotSupportedByMailFlowSRulesEngineForwardingCanBeConfiguredInMailFlowRules", { defaultValue: "Existing-message runs cover the Inbox only and do not run your other filters. Native MailFlow label actions are account-specific and do not sync provider labels. Label conditions, importance and never-spam are not supported by MailFlow’s rules engine. Forwarding can be configured in MailFlow Rules." })}</p>
      {notice && <p role="alert">{notice}</p>}
      {run && run.runId === runAttempt.current && <div className="gmail-search-actions"><button type="button" onClick={() => checkRun(run)}>{t("gmailSearch.checkRunStatus", { defaultValue: "Check run status" })}</button>{['running', 'cancelling', 'unknown'].includes(run.status) && <button type="button" disabled={run.status === 'cancelling'} onClick={stopRun}>{t("gmailSearch.stopRun", { defaultValue: "Stop run" })}</button>}</div>}
      <div className="gmail-search-actions"><button type="button" disabled={busy} onClick={close}>{t("gmailSearch.cancel", { defaultValue: "Cancel" })}</button><button type="submit" className="gmail-search-primary" disabled={busy || saveUncertain || (!!runAttempt.current && run?.runId === runAttempt.current)}>{busy ? 'Saving…' : savedRuleId ? 'Retry applying filter' : 'Create filter'}</button></div>
    </form>}
  </div>;
}

export function GmailSearchRefinements({ query, onChange }) {
  const { t } = useTranslation();
  const [recipient, setRecipient] = useState('');
  const [showRecipient, setShowRecipient] = useState(false);
  const attachment = hasSearchRefinement(query, 'has', 'attachment') || hasSearchRefinement(query, 'has', 'attachments');
  const refine = (operator, value) => onChange(refineSearchQuery(query, operator, value));
  return <div className="gmail-search-refinements" aria-label={t("gmailSearch.searchRefinements", { defaultValue: "Search refinements" })}>
    <span>{t("gmailSearch.mail", { defaultValue: "Mail" })}</span>
    <select aria-label={t("gmailSearch.searchDateRange", { defaultValue: "Search date range" })} defaultValue="" onChange={event => { if (event.target.value) refine('after', new Date(Date.now() - Number(event.target.value) * 86400000).toISOString().slice(0, 10)); else refine('after', ''); }}><option value="">{t("gmailSearch.anyTime", { defaultValue: "Any time" })}</option><option value="1">{t("gmailSearch.pastDay", { defaultValue: "Past day" })}</option><option value="7">{t("gmailSearch.pastWeek", { defaultValue: "Past week" })}</option><option value="30">{t("gmailSearch.pastMonth", { defaultValue: "Past month" })}</option><option value="365">{t("gmailSearch.pastYear", { defaultValue: "Past year" })}</option></select>
    <button type="button" aria-pressed={attachment} onClick={() => refine('has', attachment ? '' : 'attachment')}>{t("gmailSearch.hasAttachment", { defaultValue: "Has attachment" })}</button>
    <button type="button" aria-expanded={showRecipient} onClick={() => setShowRecipient(!showRecipient)}>{t("gmailSearch.to", { defaultValue: "To" })}</button>
    {showRecipient && <form onSubmit={event => { event.preventDefault(); if (recipient.trim()) refine('to', recipient.trim()); setShowRecipient(false); }}><SearchAddressInput aria-label={t("gmailSearch.recipient", { defaultValue: "Recipient" })} placeholder={t("gmailSearch.nameOrEmail", { defaultValue: "Name or email" })} value={recipient} onChange={event => setRecipient(event.target.value)}/><button type="button" onClick={() => { setRecipient(''); refine('to', ''); setShowRecipient(false); }}>{t("gmailSearch.clear", { defaultValue: "Clear" })}</button><button type="submit">{t("gmailSearch.apply", { defaultValue: "Apply" })}</button></form>}
    <button type="button" onClick={() => document.querySelector('.gmail-search-options')?.click()}>{t("gmailSearch.advancedSearch", { defaultValue: "Advanced search" })}</button><span className="gmail-search-sort">{t("gmailSearch.mostRecent", { defaultValue: "Most recent" })}</span>
  </div>;
}
