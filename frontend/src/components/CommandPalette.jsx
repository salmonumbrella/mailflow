import { useState, useEffect, useLayoutEffect, useRef, useCallback, useId } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { useMobile } from '../hooks/useMobile.js';
import { THEMES } from '../themes.js';
import { LAYOUTS } from '../layouts.js';
import { shortcutBus } from '../utils/shortcutBus.js';
import { canRunMailCommand, mailCommandDefinitions } from '../utils/mailCommands.js';
import { selectedMessage } from '../utils/messageHotkeys.js';
import { api } from '../utils/api.js';
import { labelPickerOptions, pickerNavigationDirection, executeLabelChoice } from '../utils/labelPicker.js';

const THEME_NAMES = Object.keys(THEMES);

function buildActions({ t, openCompose, setSelectedAccount, setShowAdmin, setAdminTab, theme, setTheme, accounts, layout, setLayout }) {
  const actions = [
    {
      id: 'compose',
      label: t('commandPalette.actions.compose'),
      icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
      run: () => openCompose({}),
    },
    {
      id: 'inbox',
      label: t('commandPalette.actions.inbox'),
      icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg>,
      run: () => setSelectedAccount(null, 'INBOX'),
    },
    {
      id: 'settings',
      label: t('commandPalette.actions.settings'),
      icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
      run: () => { setShowAdmin(true); setAdminTab('accounts'); },
    },
    {
      id: 'themes',
      label: t('commandPalette.actions.themes'),
      icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 010 20"/><path d="M12 2v20"/></svg>,
      run: () => { setShowAdmin(true); setAdminTab('appearance'); },
    },
  ];

  actions.unshift({
    id: 'workspace:superhuman',
    label: t('commandPalette.actions.superhuman', { defaultValue: 'Use Superhuman workspace' }),
    detail: t('commandPalette.actions.superhumanDetail', { defaultValue: 'Focused inbox, graphite theme, and keyboard-first commands' }),
    icon: <span style={{ width: 15, textAlign: 'center' }}>⌘</span>,
    active: theme === 'superhuman' && layout === 'superhuman',
    run: () => { setTheme('superhuman'); setLayout('superhuman'); },
  });
  for (const [key, definition] of Object.entries(LAYOUTS)) {
    actions.push({
      id: `layout:${key}`,
      label: t('commandPalette.actions.switchLayout', {
        layout: t(definition.labelKey, { defaultValue: definition.label }), defaultValue: 'Use {{layout}} layout',
      }),
      icon: <span style={{ width: 15, textAlign: 'center' }}>▤</span>,
      active: layout === key,
      run: () => setLayout(key),
    });
  }

  // Theme switch actions
  for (const themeKey of THEME_NAMES) {
    const label = THEMES[themeKey]?.label || themeKey;
    actions.push({
      id: `theme:${themeKey}`,
      label: t('commandPalette.actions.switchTheme', { theme: label }),
      icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>,
      active: theme === themeKey,
      run: () => setTheme(themeKey),
    });
  }

  // Per-account inbox shortcuts
  for (const a of accounts) {
    actions.push({
      id: `account:${a.id}`,
      label: t('commandPalette.actions.accountInbox', { name: a.name }),
      icon: a.icon
        ? <span style={{ fontSize: 15, lineHeight: 1, width: 15, display: 'inline-block', textAlign: 'center', flexShrink: 0 }}>{a.icon}</span>
        : <span style={{ width: 15, height: 15, borderRadius: '50%', background: a.color || '#6366f1', display: 'inline-block', flexShrink: 0 }} />,
      run: () => setSelectedAccount(a.id, 'INBOX'),
    });
  }

  return actions;
}

function MailCommandIcon({ action }) {
  const paths = {
    archive: 'M5 12l4 4L19 6',
    snooze: 'M12 8v4l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
    reply: 'M9 5l-7 7 7 7M2 12h11a7 7 0 0 1 7 7',
    replyAll: 'M7 6l-6 6 6 6M13 6l-6 6 6 6M7 12h8a7 7 0 0 1 7 7',
    forward: 'M15 5l7 7-7 7M22 12H11a7 7 0 0 0-7 7',
    toggleRead: 'M3 5h18v14H3zM3 5l9 8 9-8',
    markUnread: 'M3 5h18v14H3zM3 5l9 8 9-8',
    toggleStar: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z',
    openLabelPicker: 'M3 3h8l10 10-8 8L3 11zM7 7h.01',
    moveMessage: 'M3 7h7l2-3h9v16H3z',
    delete: 'M3 6h18M5 6l1 15h12l1-15M9 6V3h6v3M10 10v7M14 10v7',
    undoAction: 'M3 5v6h6M3 11a9 9 0 1 1 2 8',
    focusSearch: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    showHelp: 'M3 5h18v14H3zM6 8h1m3 0h1m3 0h1m3 0h1M6 11h1m3 0h1m3 0h1m3 0h1M7 16h10',
  };
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[action]} /></svg>;
}

export default function CommandPalette({ open, onClose, labelPickerMessage = null }) {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const state = useStore();
  const { accounts, folders, addNotification, layout } = state;
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [listScrolled, setListScrolled] = useState(false);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const busyRef = useRef(false);
  const sessionRef = useRef({ value: 0 });
  const listId = useId();
  const superhuman = layout === 'superhuman';

  const pickerAccount = accounts.find(account => account.id === labelPickerMessage?.account_id);
  const actions = labelPickerMessage
    ? labelPickerOptions(folders[labelPickerMessage.account_id], pickerAccount, labelPickerMessage.folder)
      .map(choice => ({
        id: `label:${choice.path}`,
        label: t('commandPalette.labelPicker.copyTo', { folder: choice.label, defaultValue: 'Copy to {{folder}}' }),
        icon: <span style={{ width: 15, textAlign: 'center' }}>◇</span>,
        run: () => executeLabelChoice(labelPickerMessage, choice,
          { getThread: api.getThread, copyMessage: api.copyMessage }),
      }))
    : [
      ...mailCommandDefinitions(state, t).filter(command => !isMobile || command.action !== 'showHelp').map(command => ({
        ...command,
        icon: <MailCommandIcon action={command.action} />,
        closeBeforeRun: true,
        run: () => shortcutBus.emit(command.action),
      })),
      ...buildActions({ t, ...state }).map(action => ({ ...action, closeBeforeRun: true,
        disabled: state.composing || state.showAdmin || state.showContacts })),
    ];

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? actions.filter(action => `${action.label} ${action.detail || ''} ${action.keywords || ''}`.toLowerCase().includes(normalizedQuery))
    : actions;
  const activeIndex = filtered[activeIdx] && !filtered[activeIdx].disabled
    ? activeIdx : filtered.findIndex(action => !action.disabled);

  useLayoutEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement;
    const input = inputRef.current;
    const session = sessionRef.current;
    session.value++;
    setQuery('');
    setActiveIdx(0);
    setListScrolled(false);
    input?.focus();
    return () => {
      session.value++;
      if (previousFocus?.isConnected && (document.activeElement === input || document.activeElement === document.body)) {
        previousFocus.focus();
      }
    };
  }, [open, labelPickerMessage?.id]);

  useEffect(() => { setActiveIdx(0); }, [query]);

  const runAction = useCallback(async (action) => {
    if (!action || action.disabled || busyRef.current) return;
    if (action.action) {
      const live = useStore.getState();
      if (!canRunMailCommand(action.action, live)) return;
      if (action.targetId != null && selectedMessage(live)?.id !== action.targetId) return;
    }
    busyRef.current = true;
    const session = sessionRef.current.value;
    try {
      // Close and restore the old focus before the native handler opens a picker,
      // composer or search field. Closing afterwards would dismiss that new UI.
      if (action.closeBeforeRun) flushSync(() => {
        if (action.targetId != null) shortcutBus.emit('clearBulkSelection');
        onClose();
      });
      if (action.targetId != null && selectedMessage(useStore.getState())?.id !== action.targetId) return;
      await action.run();
      if (!action.closeBeforeRun && sessionRef.current.value === session) onClose();
    } catch (error) {
      addNotification({
        title: labelPickerMessage ? t('commandPalette.labelPicker.error', { defaultValue: 'Could not label message' })
          : t('commandPalette.error', { defaultValue: 'Could not run command' }),
        body: error.message,
      });
    } finally {
      busyRef.current = false;
    }
  }, [onClose, addNotification, t, labelPickerMessage]);

  const handleKeyDown = (event) => {
    if (event.defaultPrevented || event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229) return;
    const togglePalette = (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k';
    const direction = !labelPickerMessage && togglePalette ? 0 : pickerNavigationDirection(event);
    if (direction) {
      event.preventDefault();
      event.stopPropagation();
      let next = activeIndex;
      do { next += direction; } while (next >= 0 && next < filtered.length && filtered[next].disabled);
      if (next >= 0 && next < filtered.length) setActiveIdx(next);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      void runAction(filtered[activeIndex]);
    } else if (event.key === 'Escape' || togglePalette) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      inputRef.current?.focus();
    }
  };

  useEffect(() => {
    listRef.current?.children[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  if (!open) return null;
  const placeholder = labelPickerMessage ? t('commandPalette.labelPicker.placeholder', { defaultValue: 'Copy or label selected message…' })
    : superhuman ? t('commandPalette.superhumanPlaceholder', { defaultValue: 'What would you like to do?' }) : t('commandPalette.placeholder');

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9500,
        background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '15vh',
        animation: 'backdrop-enter var(--motion-fast) var(--ease-standard) both',
      }}
      onClick={onClose}
    >
      <div
        role="dialog" aria-modal="true" aria-label={labelPickerMessage ? placeholder : t('commandPalette.title', { defaultValue: 'Command palette' })}
        onKeyDown={handleKeyDown}
        style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          borderRadius: 12, width: '100%', maxWidth: superhuman ? 580 : 520, margin: '0 16px',
          boxShadow: 'var(--shadow-modal)', overflow: 'hidden',
          animation: 'modal-enter var(--motion-fast) var(--ease-emphasized) backwards',
        }}
        onClick={event => event.stopPropagation()}
      >
        {superhuman && !labelPickerMessage && <div style={{ padding: '14px 18px 0', color: 'var(--text-tertiary)', fontSize: 10, fontWeight: 700, letterSpacing: '0.13em', textTransform: 'uppercase' }}>
          {t('commandPalette.superhumanTitle', { defaultValue: 'Superhuman Command' })}
        </div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            ref={inputRef} role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={listId}
            aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
            aria-label={t('commandPalette.searchLabel', { defaultValue: 'Search commands' })}
            value={query} onChange={event => setQuery(event.target.value)} placeholder={placeholder}
            style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: 15 }}
          />
          {!isMobile && <kbd style={{ fontSize: 11, color: 'var(--text-tertiary)', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 6px' }}>Esc</kbd>}
        </div>
        <div
          ref={listRef} id={listId} role="listbox" aria-label={t('commandPalette.results', { defaultValue: 'Commands' })}
          onScroll={event => setListScrolled(event.currentTarget.scrollTop > 4)}
          style={{ maxHeight: 390, overflowY: 'auto', padding: '6px 0', boxShadow: listScrolled ? 'inset 0 8px 8px -8px rgba(0,0,0,0.25)' : 'none', transition: 'box-shadow 0.2s ease' }}
        >
          {filtered.length === 0 ? (
            <div role="status" style={{ padding: '20px 16px', color: 'var(--text-tertiary)', fontSize: 13, textAlign: 'center' }}>{t('commandPalette.noResults')}</div>
          ) : filtered.map((action, index) => (
            <div
              key={action.id} id={`${listId}-${index}`} data-command-id={action.id}
              role="option" aria-selected={index === activeIndex} aria-disabled={Boolean(action.disabled)}
              onClick={() => { void runAction(action); }}
              onMouseEnter={() => { if (!action.disabled) setActiveIdx(index); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '9px 16px',
                cursor: action.disabled ? 'default' : 'pointer', opacity: action.disabled ? 0.4 : 1,
                background: index === activeIndex ? 'var(--bg-hover)' : 'transparent', transition: 'background 0.08s',
              }}
            >
              <span style={{ color: action.active ? 'var(--accent)' : 'var(--text-tertiary)', display: 'flex', flexShrink: 0 }}>{action.icon}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13, color: action.active ? 'var(--accent)' : 'var(--text-primary)' }}>{action.label}</span>
                {action.detail && <span style={{ display: 'block', marginTop: 3, fontSize: 11, color: 'var(--text-tertiary)' }}>{action.detail}</span>}
              </span>
              {action.shortcut && !isMobile && <kbd style={{ fontSize: 10, color: 'var(--text-tertiary)', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 5px', flexShrink: 0 }}>{action.shortcut}</kbd>}
              {action.active && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>}
            </div>
          ))}
        </div>
        {!isMobile && (
          <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border-subtle)', display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-tertiary)' }}>
            <span>↑↓ {t('commandPalette.hint.navigate')}</span>
            <span>↵ {t('commandPalette.hint.select')}</span>
            <span>Esc {t('commandPalette.hint.close')}</span>
          </div>
        )}
      </div>
    </div>
  );
}
