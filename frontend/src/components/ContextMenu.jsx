import { Fragment, useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { copyToClipboard } from '../utils/clipboard.js';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { getContextMenuPolicy, resolveContextMenuMessage } from '../utils/contextMenuPolicy.js';
import { downloadEml } from '../utils/downloadEml.js';
import { isSnoozed } from '../utils/snoozeActions.js';
import { SNOOZE_DEFAULT_TIME, snoozeCustomUntil, snoozeDefaultDate, snoozeMinDate } from '../utils/snoozeTimes.js';
import { usePluginCollected } from '../plugins/PluginSlot.jsx';
import MessageHeaderModal from './MessageHeaderModal.jsx';
import FolderPathLabel from './FolderPathLabel.jsx';
import { buildMovePickerSections, movePickerSectionHeading, movePickerFoldersEmpty, runMovePickerAction } from '../utils/folderDisplay.js';
import { useUiScale, descale } from '../hooks/useUiScale.js';
import { createListActionCommitGuard, listMessageIdentity, listActionSourceKey } from '../utils/listActionScope.js';
import { nativeLabelActionsBlocked } from '../utils/nativeLabelNavigation.js';
import { useMobile } from '../hooks/useMobile.js';

// Module-level regex — spam-name heuristic shared with MessagePane.jsx so
// it isn't recompiled on every render. Mirrors resolveAllSpamPaths on the
// backend; keep these three in sync when adding a new locale.
const SPAM_NAME_RE = /(spam|junk|bulk|indesiderata|spamverdacht|courrier\s*ind|posta\s*indesiderata)/i;

// ─── Context Menu ─────────────────────────────────────────────────────────────
const CATEGORIES = ['primary', 'newsletter', 'promotion', 'automated', 'social'];

export default function ContextMenu({ x, y, message, onClose: closeMenu, onAction: dispatchAction, openerElement, defaultMoveView = false, defaultSnoozeView = false, variant = 'inbox', selectedText = '' }) {
  const { t } = useTranslation();
  const uiScale = useUiScale();
  const isMobile = useMobile();
  const gmailKeyboard = useStore(s => s.layout === 'gmail');
  // Variants share one menu; the policy removes actions that depend on the center
  // list or conflict with GTD's Done contract while preserving ordinary mail actions.
  const menuPolicy = getContextMenuPolicy(variant);
  const recentFolders = useStore(s => s.recentFolders);
  const favoriteFolders = useStore(s => s.favoriteFolders);
  // Pull the current account so we can render the spam/ham visibility based on
  // folder_mappings.spam + special_use heuristics instead of a fragile name match.
  const account = useStore(s => s.accounts.find(a => a.id === message.account_id));
  const accountFolders = useStore(s => s.folders[message.account_id] || []);
  const categorizationEnabled = useStore(s => s.categorizationEnabled);
  const categorizationActive = categorizationEnabled || !!account?.categorization_enabled;
  const menuRef = useRef(null);
  const [headerMessage, setHeaderMessage] = useState(null);
  // A plugin submenu (render fn) takes over the menu content area, like categorizeView/moveView.
  // Set via the openSubmenu capability handed to context-menu-item contributions; null = item list.
  const [pluginSubmenu, setPluginSubmenu] = useState(null);
  const [pluginMenuCommands, setPluginMenuCommands] = useState(false);
  const [moveView, setMoveView] = useState(defaultMoveView);
  const [moveFolders, setMoveFolders] = useState(null);
  const [moveFoldersLoading, setMoveFoldersLoading] = useState(defaultMoveView);
  const [snoozeView, setSnoozeView] = useState(defaultSnoozeView);
  // The snooze picker snoozes, or for a message already snoozed changes when it comes back (#269).
  const snoozeAction = isSnoozed(message) ? 'changeSnooze' : 'snooze';
  const [customSnoozeView, setCustomSnoozeView] = useState(false);
  const [customDate, setCustomDate] = useState('');
  const [customTime, setCustomTime] = useState(SNOOZE_DEFAULT_TIME);
  // false, or which category list is open: 'message' (this message), 'sender' or 'domain' (#490).
  const [categorizeView, setCategorizeView] = useState(false);
  const [folderSearch, setFolderSearch] = useState('');
  const unreadCount = Number.parseInt(message.unread_count, 10);
  const hasUnread = Number.isFinite(unreadCount) ? unreadCount > 0 : !message.is_read;
  const isMessagePane = variant === 'messagePane';
  const hasSelectedText = Boolean(String(selectedText || '').trim());

  // Freeze the opening identity. Never re-arm this menu when a removed account,
  // generation, lock, user, navigation or source row later returns to its old value.
  const [opening] = useState(() => {
    const state = useStore.getState();
    const opener = openerElement || document.activeElement;
    return {
      current: createListActionCommitGuard([message], state),
      navigation: menuNavigationKey(state), identity: listMessageIdentity(message), message: { ...message },
      source: variant === 'inbox' ? listActionSourceKey([message], state) : null,
      opener, openerRow: opener?.closest?.('[data-gmail-row-id]'),
      openerRowId: opener?.closest?.('[data-gmail-row-id]')?.dataset.gmailRowId,
      openerOwnRowId: opener?.dataset?.gmailRowId,
    };
  });
  const alive = useRef(true);
  const folderRequest = useRef(0);
  const messageIdentity = listMessageIdentity(message);
  const currentContext = useCallback(() => {
    const state = useStore.getState();
    return !state.isLocked && !nativeLabelActionsBlocked(state)
      && opening.current(state) && opening.navigation === menuNavigationKey(state)
      && opening.identity === messageIdentity
      && (!opening.source || opening.source === listActionSourceKey([opening.message], state));
  }, [opening, messageIdentity]);
  const onClose = useCallback((restore = true) => {
    if (!alive.current) return;
    alive.current = false;
    folderRequest.current++;
    const focused = document.activeElement;
    if (gmailKeyboard && restore && currentContext()
      && (menuRef.current?.contains(focused) || focused === document.body || focused === opening.opener)
      && visibleMenuOpener(opening)) opening.opener.focus({ preventScroll: true });
    closeMenu();
  }, [closeMenu, gmailKeyboard, currentContext, opening]);
  const onAction = (...args) => {
    if (alive.current && currentContext()) dispatchAction(...args);
  };
  useEffect(() => {
    alive.current = true;
    const requests = folderRequest;
    return () => { alive.current = false; requests.current++; };
  }, []);
  useEffect(() => {
    const validate = () => { if (!currentContext()) onClose(false); };
    validate();
    const unsubscribe = useStore.subscribe(validate);
    return unsubscribe;
  }, [currentContext, onClose]);

  const activeView = headerMessage ? 'headers' : pluginSubmenu ? 'plugin' : categorizeView
    ? `category-${categorizeView}` : snoozeView ? (customSnoozeView ? 'custom-snooze' : 'snooze')
    : moveView ? 'move' : 'main';
  const commandView = !headerMessage && (!pluginSubmenu || pluginMenuCommands) && !moveView && !customSnoozeView;
  const rememberedFocus = useRef(new Map());
  const itemProps = (disabled = false, role = 'menuitem', hasSubmenu = false) => gmailKeyboard ? {
    role, tabIndex: role === 'button' && !disabled ? 0 : -1,
    'data-context-command': '', 'aria-disabled': disabled || undefined,
    'aria-haspopup': hasSubmenu ? (typeof hasSubmenu === 'string' ? hasSubmenu : 'menu') : undefined,
    'aria-expanded': hasSubmenu ? false : undefined,
  } : {};
  const goBack = () => {
    if (headerMessage) setHeaderMessage(null);
    else if (pluginSubmenu) setPluginSubmenu(null);
    else if (categorizeView) setCategorizeView(categorizeView === 'message' ? false : 'message');
    else if (customSnoozeView) setCustomSnoozeView(false);
    else if (snoozeView && !defaultSnoozeView) setSnoozeView(false);
    else if (moveView && !defaultMoveView) setMoveView(false);
    else onClose();
  };
  useLayoutEffect(() => {
    if (!gmailKeyboard || !alive.current) return;
    const menu = menuRef.current;
    const remembered = rememberedFocus.current.get(activeView);
    const commands = [...menu.querySelectorAll('[data-context-command]:not([aria-disabled="true"])')];
    const previous = commands.find(item => item.textContent === remembered);
    const focusable = menu.querySelector('input:not(:disabled)')
      || menu.querySelector('button:not(:disabled), [tabindex="0"]');
    (previous || (commandView ? commands[0] : focusable) || menu).focus({ preventScroll: true });
  }, [activeView, commandView, gmailKeyboard]);

  const handleMenuKey = event => {
    if (!gmailKeyboard) return;
    event.stopPropagation();
    if (!alive.current || !currentContext()) { event.preventDefault(); return; }
    if (event.defaultPrevented || event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229) return;
    const nestedDialog = event.target.closest('[role="dialog"], [aria-modal="true"]');
    if (nestedDialog && nestedDialog !== menuRef.current) return;
    if (event.key === 'Tab') {
      // A true command menu exits on Tab. Forms keep ordinary native tab order;
      // their blur handler dismisses only once focus leaves the whole popup.
      if (commandView) onClose();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const editable = event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
    const searchArrow = moveView && editable?.dataset.contextFolderSearch !== undefined
      && ['ArrowDown', 'ArrowUp'].includes(event.key);
    if (editable && !searchArrow) return;
    if (event.key === 'ArrowLeft' && activeView !== 'main') {
      event.preventDefault(); goBack(); return;
    }
    const commands = [...menuRef.current.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])')];
    const target = event.target.closest('[data-context-command]');
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && (commands.length || commandView)) {
      event.preventDefault();
      const index = commands.indexOf(target);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? commands.length - 1
        : index < 0 ? (event.key === 'ArrowUp' ? commands.length - 1 : 0)
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + commands.length) % commands.length;
      commands[next]?.focus({ preventScroll: true });
      commands[next]?.scrollIntoView?.({ block: 'nearest' });
    } else if (target && target.getAttribute('aria-disabled') !== 'true'
      && (['Enter', ' '].includes(event.key) || event.key === 'ArrowRight' && target.hasAttribute('aria-haspopup'))) {
      event.preventDefault();
      if (!event.repeat) target.click();
    }
  };

  // A folder is "spam-like" when either the user mapped it as spam or the IMAP
  // server tagged it with \Junk special-use. Falls back to a multilingual name
  // heuristic so unconfigured accounts still get sensible context-menu items.
  // Mirrors resolveAllSpamPaths on the backend so server and client agree.
  const spamFolderPaths = (() => {
    const mapped = account?.folder_mappings?.spam;
    if (mapped) return new Set([mapped]);
    return new Set(accountFolders.filter(f =>
      f.special_use === '\\Junk' || SPAM_NAME_RE.test(f.name || '')
    ).map(f => f.path));
  })();
  const inSpamFolder = spamFolderPaths.has(message.folder);

  // Adjust position to stay within viewport. The menu's height changes after
  // mount (folders load async, subviews like Move/Snooze swap in), so re-clamp
  // on every size change — measuring only at open time lets a menu that grows
  // near the bottom edge overflow off-screen.
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    // Mobile renders a fixed, vertically-centered slide-out panel (see the
    // container style below), so the tap-point clamp is desktop-only.
    if (isMobile) return;
    const clamp = () => {
      const rect = menu.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const nx = Math.max(0, Math.min(vw - rect.width, x + rect.width > vw ? x - rect.width : x));
      const ny = Math.max(0, Math.min(vh - rect.height, y + rect.height > vh ? y - rect.height : y));
      setPos(prev => (prev.x === nx && prev.y === ny ? prev : { x: nx, y: ny }));
    };
    clamp();
    const observer = new ResizeObserver(clamp);
    observer.observe(menu);
    window.addEventListener('resize', clamp);
    return () => { observer.disconnect(); window.removeEventListener('resize', clamp); };
  }, [x, y, isMobile]);

  const loadMoveFolders = useCallback(async () => {
    if (!alive.current || !currentContext()) return;
    const request = ++folderRequest.current;
    const current = () => alive.current && request === folderRequest.current && currentContext();
    setMoveFoldersLoading(true);
    try {
      const data = await api.getFolders(message.account_id);
      if (current()) setMoveFolders(Array.isArray(data) ? data : (data.folders || []));
    } catch {
      if (current()) setMoveFolders([]);
    } finally {
      if (current()) setMoveFoldersLoading(false);
    }
  }, [message.account_id, currentContext]);

  useEffect(() => {
    if (defaultMoveView) void loadMoveFolders();
  }, [defaultMoveView, loadMoveFolders]);

  const handleMoveClick = () => {
    if (!alive.current || !currentContext()) return;
    setMoveView(true);
    if (!moveFolders) void loadMoveFolders();
  };

  // Capture Escape before the reader/compose/global shortcut listeners. Only the
  // active layer is dismissed. The scrim still catches outside iframe clicks.
  useEffect(() => {
    const handleKey = event => {
      if (event.key !== 'Escape' || !alive.current || event.isComposing || event.keyCode === 229) return;
      if (gmailKeyboard) {
        const dialog = event.target.closest?.('[role="dialog"], [aria-modal="true"]');
        if (dialog && dialog !== menuRef.current && !headerMessage) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (!event.repeat) goBack();
      } else onClose();
    };
    document.addEventListener('keydown', handleKey, gmailKeyboard);
    const handleScroll = event => {
      if (!menuRef.current?.contains(event.target)) onClose();
    };
    if (gmailKeyboard) document.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('keydown', handleKey, gmailKeyboard);
      document.removeEventListener('scroll', handleScroll, true);
    };
  });

  // Plugin-contributed action items (currently GTD's submenu + sidebar "Done"), spliced into the
  // Actions group at the seam below. Core stays plugin-agnostic; openSubmenu lets an item take over
  // the content area with its own submenu render.
  const pluginActionItems = usePluginCollected('context-menu-actions', {
    message, account, variant, onAction, onClose,
    openSubmenu: (render, options) => {
      if (!alive.current || !currentContext()) return;
      setPluginMenuCommands(options?.type === 'menu');
      setPluginSubmenu(() => render);
    },
    getMenuItemProps: itemProps,
    t,
  });

  const movePluginSections = usePluginCollected('move-picker-sections', {
    account, messages: [message], currentFolder: message.folder, onClose, t,
  });

  const items = [
    ...(isMessagePane ? [
      {
        group: 'Reading',
        actions: [
          {
            label: t('common.copy'),
            icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>,
            action: () => onAction('copySelection'),
            disabled: !hasSelectedText,
          },
          {
            label: t('messageList.selectAll'),
            icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 7h10v10H7z"/></svg>,
            action: () => onAction('selectAllContent'),
          },
          {
            label: t('contextMenu.find'),
            icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>,
            action: () => onAction('findInContent'),
          },
        ],
      },
      {
        group: 'Print',
        actions: [
          {
            label: t('message.print'),
            icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>,
            action: () => onAction('print'),
          },
        ],
      },
    ] : []),
    {
      group: 'Message',
      actions: [
        ...(isMessagePane ? [] : [{
          label: t('contextMenu.open'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>,
          action: () => onAction('open'),
        }]),
        // Detached windows don't exist on mobile — handleOpenInWindow no-ops
        // there — so hide this rather than show a dead item.
        ...(isMessagePane || isMobile ? [] : [{
          label: t('contextMenu.openInNewWindow'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg>,
          action: () => onAction('openWindow'),
        }]),
        {
          label: hasUnread ? t('contextMenu.markRead') : t('contextMenu.markUnread'),
          icon: hasUnread
            ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path style={{strokeLinecap: 'round'}} d="M22,9v9c0,1.1-.9,2-2,2H4c-1.1,0-2-.9-2-2v-9"/><polyline points="22 9 12 16 2 9"/><polyline points="2 9 12 2 22 9"/></svg>
            : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path style={{strokeLinecap: 'round'}} d="M22,10.91v7.09c0,1.1-.9,2-2,2H4c-1.1,0-2-.9-2-2V6c0-1.1.9-2,2-2h11"/><polyline style={{strokeLinecap: 'round'}} points="16.36 9.95 12 13 2 6"/><circle style={{strokeMiterlimit: 10, fill: 'currentColor'}} cx="19.96" cy="6" r="3"/></svg>,
          action: () => onAction(hasUnread ? 'markRead' : 'markUnread'),
        },
        {
          label: message.is_starred ? t('contextMenu.unstar') : t('contextMenu.star'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24"
            fill={message.is_starred ? 'var(--amber)' : 'none'}
            stroke={message.is_starred ? 'var(--amber)' : 'currentColor'} strokeWidth="1.75">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>,
          action: () => onAction('toggleStar'),
        },
        ...(!menuPolicy.select ? [] : [{
          label: t('contextMenu.select'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><rect x="3" y="3" width="18" height="18" rx="3"/><polyline points="9 12 11 14 15 10"/></svg>,
          action: () => onAction('bulkSelect'),
        }]),
      ]
    },
    {
      group: 'Actions',
      actions: [
        ...(!menuPolicy.compose ? [] : [{
          label: t('contextMenu.reply'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 00-4-4H4"/></svg>,
          action: () => onAction('reply'),
        },
        {
          label: t('contextMenu.replyAll'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="7 17 2 12 7 7"/><polyline points="12 17 7 12 12 7"/><path d="M22 18v-2a4 4 0 00-4-4H7"/></svg>,
          action: () => onAction('replyAll'),
        },
        {
          label: t('contextMenu.forward'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 014-4h12"/></svg>,
          action: () => onAction('forward'),
        },
        {
          // The original as an .eml with all its headers, e.g. for SpamCop (#466).
          label: t('contextMenu.forwardAsAttachment'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>,
          action: () => onAction('forwardAsAttachment'),
        }]),
        {
          label: t('contextMenu.moveToFolder'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>,
          action: handleMoveClick,
          submenuRole: 'dialog',
          keepOpen: true,
          hasSubmenu: true,
        },
        ...(!menuPolicy.archive ? [] : [{
          label: t('contextMenu.archive'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a1 1 0 001 1h14a1 1 0 001-1V8"/><polyline points="9 13 12 16 15 13"/><line x1="12" y1="11" x2="12" y2="16"/></svg>,
          action: () => onAction('archive'),
        }]),
        ...(!isSnoozed(message) && menuPolicy.snooze ? [{
          label: t('contextMenu.snooze.label'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
          action: () => setSnoozeView(true),
          keepOpen: true,
          hasSubmenu: true,
        }] : []),
        // A snoozed message (#269): change when it comes back, with the same picker, or bring it back now.
        ...(isSnoozed(message) && menuPolicy.snooze ? [{
          label: t('contextMenu.snooze.change'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
          action: () => setSnoozeView(true),
          keepOpen: true,
          hasSubmenu: true,
        }, {
          label: t('contextMenu.snooze.unsnooze'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>,
          action: () => onAction('unsnooze'),
        }] : []),
        ...(categorizationActive && menuPolicy.categorize ? [{
          label: t('contextMenu.categorize'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>,
          action: () => setCategorizeView('message'),
          keepOpen: true,
          hasSubmenu: true,
        }] : []),
        // Plugin-contributed items (GTD's submenu + sidebar "Done") slot in here, exactly where the
        // GTD entries used to sit — after "Categorize", before "Create rule".
        ...pluginActionItems.map(item => ({ submenuRole: 'dialog', ...item })),
        ...(!menuPolicy.rules ? [] : [{
          label: t('contextMenu.createRule'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>,
          action: () => onAction('createRuleFromMessage'),
        },
        {
          label: t('contextMenu.addToBlockList'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>,
          action: () => onAction('addToBlockList'),
        }]),
        // Spam / ham are only shown when there's a real destination for the
        // action: "Mark as Spam" when the message isn't already in a spam-like
        // folder, "Mark as Not Spam" when it is. They live next to "Move to
        // folder" so the antispam workflow stays discoverable.
        ...(spamFolderPaths.size > 0 && !inSpamFolder && menuPolicy.spam ? [{
          label: t('contextMenu.markAsSpam'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M12 3L4 7v5c0 5 3.5 9.3 8 10.3C16.5 21.3 20 17 20 12V7L12 3z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>,
          action: () => onAction('markSpam'),
        }] : []),
        ...(inSpamFolder && menuPolicy.spam ? [{
          label: t('contextMenu.markAsHam'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M12 3L4 7v5c0 5 3.5 9.3 8 10.3C16.5 21.3 20 17 20 12V7L12 3z"/><polyline points="9 12 11 14 15 10"/></svg>,
          action: () => onAction('markHam'),
        }] : []),
      ]
    },
    ...(!(menuPolicy.copy || menuPolicy.viewHeaders) ? [] : [{
      group: 'Copy',
      actions: [
        {
          label: t('contextMenu.copySubject'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>,
          action: () => { copyToClipboard(message.subject || ''); onAction('copy'); },
        },
        {
          label: t('contextMenu.copySender'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>,
          action: () => { copyToClipboard(message.from_email || ''); onAction('copy'); },
        },
        {
          // Durable permalink to this email: keyed on the stable Message-ID header (falls back to
          // the volatile row UUID only when absent) so it survives the message moving folders /
          // being re-synced. Resolved by /?m= on load — see MailApp deep-link handling (#270, #375).
          label: t('contextMenu.copyLink'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>,
          action: () => {
            const ref = message.message_id || message.id;
            if (ref) copyToClipboard(`${window.location.origin}/?m=${encodeURIComponent(ref)}`);
            onAction('copy');
          },
        },
      ]
    },
    {
      group: 'View',
      actions: [
        {
          label: t('contextMenu.viewHeaders'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>,
          action: async () => {
            try {
              const resolved = await resolveContextMenuMessage(message, variant, api.resolveMessage);
              if (alive.current && currentContext()) setHeaderMessage(resolved);
            } catch (err) {
              console.error('Message header resolution failed:', err.message);
            }
          },
          keepOpen: true,
        },
        {
          // Raw RFC 822 source as an .eml file (#381). Resolved like View headers, so GTD rows
          // download the current copy of the message rather than a stale row.
          label: t('message.downloadEml'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
          action: async () => {
            try {
              const resolved = await resolveContextMenuMessage(message, variant, api.resolveMessage);
              if (currentContext()) downloadEml(resolved?.id);
            } catch (err) {
              console.error('Message resolution for .eml download failed:', err.message);
            }
          },
        },
      ]
    }]),
    {
      group: 'Danger',
      actions: [
        {
          label: t('contextMenu.delete'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>,
          action: () => onAction('delete'),
          danger: true,
        },
      ]
    },
  ];

  return (
    <>
      <div onClick={() => onClose()} aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 3999 }} />
      <div
        ref={menuRef}
        data-mailflow-context-menu={gmailKeyboard ? '' : undefined}
        role={gmailKeyboard ? (commandView ? 'menu' : 'dialog') : undefined}
        aria-label={gmailKeyboard ? t(headerMessage ? 'contextMenu.headers.title' : moveView ? 'contextMenu.moveToFolder' : snoozeView ? 'contextMenu.snooze.label' : 'message.more') : undefined}
        tabIndex={gmailKeyboard ? -1 : undefined}
        onKeyDown={handleMenuKey}
        onFocusCapture={gmailKeyboard ? event => {
          const command = event.target.closest('[data-context-command]');
          if (command) rememberedFocus.current.set(activeView, command.textContent);
        } : undefined}
        onBlur={gmailKeyboard ? event => {
          if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) onClose(false);
        } : undefined}
        onClickCapture={event => {
          if (!alive.current || !currentContext()) { event.preventDefault(); event.stopPropagation(); onClose(false); }
        }}
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 10, zIndex: 4000,
          boxShadow: 'var(--shadow-modal)',
          overflowX: 'hidden', overflowY: 'auto',
          // Mobile: a left-anchored, vertically-centered slide-out panel so the
          // (often long) menu clears the notch/Dynamic Island top and bottom.
          // Desktop: positioned at the clamped tap point.
          ...(isMobile ? {
            position: 'fixed',
            left: 'calc(env(safe-area-inset-left, 0px) + 12px)',
            // Center within the SAFE area, not the raw viewport: with
            // viewport-fit=cover the island (top inset) is taller than the home
            // indicator (bottom inset), so a plain 50% sits visibly too high.
            top: 'calc(50% + (var(--sat) - var(--sab)) / 2)',
            transform: 'translateY(-50%)',
            width: 'min(340px, calc(100vw - 24px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)))',
            maxHeight: 'min(80vh, calc(100vh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 24px))',
            animation: 'contextMenuSlideIn 0.18s ease',
          } : {
            position: 'fixed', left: descale(pos.x, uiScale), top: descale(pos.y, uiScale),
            width: 320, maxWidth: 'calc(100vw - 8px)', maxHeight: 'calc(100vh - 8px)',
            animation: 'contextMenuIn 0.12s ease',
          }),
        }}
      >
        <style>{`
          [data-mailflow-context-menu] [data-context-command]:focus-visible {
            outline: 2px solid var(--accent); outline-offset: -2px;
            background: var(--bg-hover) !important;
          }
          @keyframes contextMenuIn {
            from { opacity: 0; transform: scale(0.95) translateY(-4px); }
            to   { opacity: 1; transform: scale(1) translateY(0); }
          }
          @keyframes contextMenuSlideIn {
            from { opacity: 0; transform: translate(-16px, -50%); }
            to   { opacity: 1; transform: translate(0, -50%); }
          }
        `}</style>

        {!isMessagePane && (
          <div style={{
            padding: '10px 14px 8px',
            borderBottom: '1px solid var(--border-subtle)',
          }}>
            <div style={{
              fontSize: 12, fontWeight: 500, color: 'var(--text-primary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {message.subject || t('common.noSubject')}
            </div>
            <div style={{
              fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {message.from_name
                ? `${message.from_name} <${message.from_email}>`
                : message.from_email}
            </div>
          </div>
        )}

        {headerMessage && gmailKeyboard ? (
          <MessageHeaderModal messageId={headerMessage.id} subject={headerMessage.subject} onClose={() => setHeaderMessage(null)} />
        ) : pluginSubmenu ? (
          // A plugin item opened its own submenu (e.g. GTD's classify/remove list). It renders its
          // own back row; onBack returns to the item list.
          pluginSubmenu(() => setPluginSubmenu(null))
        ) : categorizeView ? ((() => {
          // "Always for this sender/domain" needs an address to match on (#490).
          const sender = String(message.from_email || '').trim().toLowerCase();
          const at = sender.lastIndexOf('@');
          const domain = at > 0 && at < sender.length - 1 ? sender.slice(at) : '';
          const scoped = categorizeView === 'sender' || categorizeView === 'domain';
          const backRow = (label, onClick) => (
            <div
              {...itemProps()}
              onClick={onClick}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 14px', cursor: 'pointer',
                borderBottom: '1px solid var(--border-subtle)',
                color: 'var(--text-secondary)', fontSize: 12,
                overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ flexShrink: 0 }}>
                <polyline points="15 18 9 12 15 6"/>
              </svg>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
            </div>
          );
          const row = (key, label, onClick, { current = false, submenu = false } = {}) => (
            <div
              key={key}
              {...itemProps(current, 'menuitem', submenu)}
              onClick={current ? undefined : onClick}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '7px 14px', cursor: current ? 'default' : 'pointer',
                fontSize: 13, color: current ? 'var(--text-tertiary)' : 'var(--text-primary)',
              }}
              onMouseEnter={e => { if (!current) e.currentTarget.style.background = 'var(--bg-hover)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ flex: 1 }}>{label}</span>
              {current && (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              )}
              {submenu && (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2.5">
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
              )}
            </div>
          );
          if (scoped) {
            const value = categorizeView === 'sender' ? sender : domain;
            return (
              <>
                {backRow(t('contextMenu.categoryAlwaysFor', { value }), () => setCategorizeView('message'))}
                {CATEGORIES.map(cat => row(cat, t(`messageList.categories.${cat}`), () => {
                  onAction('setCategoryAlways', { scope: categorizeView, category: cat });
                  onClose();
                }))}
              </>
            );
          }
          return (
            <>
              {backRow(t('contextMenu.categorize'), () => setCategorizeView(false))}
              {CATEGORIES.map(cat => row(cat, t(`messageList.categories.${cat}`), () => {
                onAction('setCategory', cat);
                onClose();
              }, { current: (message.category || 'primary') === cat }))}
              {sender && domain && (
                <>
                  <div style={{ height: 1, background: 'var(--border-subtle)', margin: '3px 0' }} />
                  {row('always-sender', t('contextMenu.categoryAlwaysSender'), () => setCategorizeView('sender'), { submenu: true })}
                  {row('always-domain', t('contextMenu.categoryAlwaysDomain'), () => setCategorizeView('domain'), { submenu: true })}
                </>
              )}
            </>
          );
        })()
        ) : snoozeView ? (
          customSnoozeView ? (
            /* Custom date/time picker */
            <>
              <div
                {...itemProps(false, 'button')}
                onClick={() => setCustomSnoozeView(false)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 14px', cursor: 'pointer',
                  borderBottom: '1px solid var(--border-subtle)',
                  color: 'var(--text-secondary)', fontSize: 12,
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="15 18 9 12 15 6"/>
                </svg>
                {t('contextMenu.snooze.label')}
              </div>
              <div style={{ padding: '10px 14px 12px' }}>
                <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                  <input
                    type="date"
                    aria-label={t('compose.scheduleSend.dateLabel')}
                    value={customDate}
                    min={snoozeMinDate()}
                    onChange={e => setCustomDate(e.target.value)}
                    style={{
                      flex: 1, background: 'var(--bg-hover)', border: '1px solid var(--border)',
                      borderRadius: 6, color: 'var(--text-primary)', fontSize: 12,
                      padding: '5px 6px', outline: 'none', colorScheme: 'dark light',
                    }}
                  />
                  <input
                    type="time"
                    aria-label={t('compose.scheduleSend.timeLabel')}
                    value={customTime}
                    onChange={e => setCustomTime(e.target.value)}
                    style={{
                      width: 80, background: 'var(--bg-hover)', border: '1px solid var(--border)',
                      borderRadius: 6, color: 'var(--text-primary)', fontSize: 12,
                      padding: '5px 6px', outline: 'none', colorScheme: 'dark light',
                    }}
                  />
                </div>
                <button
                  disabled={!customDate || !customTime}
                  onClick={() => {
                    const d = snoozeCustomUntil(customDate, customTime);
                    if (!d) return;
                    onAction(snoozeAction, d.toISOString());
                    onClose();
                  }}
                  style={{
                    width: '100%', background: 'var(--accent)', color: 'var(--accent-text)',
                    border: 'none', borderRadius: 6, padding: '7px 0',
                    fontSize: 13, fontWeight: 500, cursor: 'pointer',
                    opacity: (!customDate || !customTime) ? 0.5 : 1,
                  }}
                >
                  {t('contextMenu.snooze.label')}
                </button>
              </div>
            </>
          ) : (
            /* Snooze preset picker */
            <>
              <div
                {...itemProps()}
                onClick={() => setSnoozeView(false)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 14px', cursor: 'pointer',
                  borderBottom: '1px solid var(--border-subtle)',
                  color: 'var(--text-secondary)', fontSize: 12,
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="15 18 9 12 15 6"/>
                </svg>
                {t(snoozeAction === 'changeSnooze' ? 'contextMenu.snooze.change' : 'contextMenu.snooze.label')}
              </div>
              {[
                {
                  label: t('contextMenu.snooze.threeHours'),
                  getDate: () => { const d = new Date(); d.setHours(d.getHours() + 3); return d; },
                },
                {
                  label: t('contextMenu.snooze.tomorrowMorning'),
                  getDate: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; },
                },
                {
                  label: t('contextMenu.snooze.nextWeek'),
                  getDate: () => { const d = new Date(); d.setDate(d.getDate() + 7); d.setHours(9, 0, 0, 0); return d; },
                },
              ].map(({ label, getDate }) => (
                <div
                  key={label}
                  {...itemProps()}
                  onClick={() => { onAction(snoozeAction, getDate().toISOString()); onClose(); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                  {label}
                </div>
              ))}
              <div
                {...itemProps(false, 'menuitem', 'dialog')}
                onClick={() => {
                  setCustomDate(snoozeDefaultDate());
                  setCustomTime(SNOOZE_DEFAULT_TIME);
                  setCustomSnoozeView(true);
                }}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                {t('contextMenu.snooze.custom')}
              </div>
            </>
          )
        ) : moveView ? (
          /* Folder picker view */
          <>
            {defaultMoveView ? (
              <div style={{
                padding: '8px 14px',
                borderBottom: '1px solid var(--border-subtle)',
                fontSize: 11, fontWeight: 600,
                color: 'var(--text-tertiary)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}>
                {t('contextMenu.folders.back')}
              </div>
            ) : (
              <div
                {...itemProps(false, 'button')}
                onClick={() => setMoveView(false)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 14px', cursor: 'pointer',
                  borderBottom: '1px solid var(--border-subtle)',
                  color: 'var(--text-secondary)', fontSize: 12,
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="15 18 9 12 15 6"/>
                </svg>
                {t('contextMenu.folders.back')}
              </div>
            )}
            <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)' }}>
              <input
                autoFocus={!gmailKeyboard && !isMobile}
                data-context-folder-search={gmailKeyboard ? '' : undefined}
                aria-label={t('contextMenu.folders.search')}
                value={folderSearch}
                onChange={e => setFolderSearch(e.target.value)}
                placeholder={t('contextMenu.folders.search')}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '5px 8px', fontSize: 12,
                  background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                  borderRadius: 5, color: 'var(--text-primary)',
                  outline: 'none',
                }}
              />
            </div>
            <div role={gmailKeyboard ? 'menu' : undefined} aria-label={gmailKeyboard ? t('contextMenu.moveToFolder') : undefined} style={{ maxHeight: 240, overflow: 'auto' }}>
              {moveFoldersLoading ? (
                <div style={{ padding: '12px 14px', color: 'var(--text-tertiary)', fontSize: 12 }}>
                  {t('contextMenu.folders.loading')}
                </div>
              ) : (() => {
                const sections = buildMovePickerSections({
                  folders: moveFolders || [], recents: recentFolders, favorites: favoriteFolders,
                  pluginSections: movePluginSections, accountId: message.account_id,
                  currentFolder: message.folder, query: folderSearch,
                });
                const foldersEmpty = movePickerFoldersEmpty(sections, moveFolders);
                const rendered = sections.map((section, i) => {
                  const heading = movePickerSectionHeading(section, t);
                  return (
                    <Fragment key={section.key}>
                      {heading && (
                        <div style={{ padding: '5px 14px 3px', color: 'var(--text-tertiary)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          {heading}
                        </div>
                      )}
                      {section.rows.map(row => row.kind === 'action' ? (
                        <FolderMenuItem
                          keyboardProps={itemProps()}
                          key={`action-${row.item.key}`}
                          icon={row.item.renderIcon(13)}
                          label={row.item.label}
                          onClick={() => runMovePickerAction(row.item, onClose)}
                        />
                      ) : (
                        <FolderMenuItem
                          keyboardProps={itemProps()}
                          key={row.folder.path}
                          folder={row.folder}
                          onClick={() => { onAction('moveTo', row.folder.path); onClose(); }}
                        />
                      ))}
                      {(i < sections.length - 1 || foldersEmpty) && <div style={{ height: 1, background: 'var(--border-subtle)', margin: '3px 0' }} />}
                    </Fragment>
                  );
                });
                return (
                  <>
                    {rendered}
                    {foldersEmpty && (
                      <div style={{ padding: '12px 14px', color: 'var(--text-tertiary)', fontSize: 12 }}>
                        {t('contextMenu.folders.empty')}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </>
        ) : (
          /* Normal groups */
          <>
            {items.map((group, gi) => (
              <div key={gi}>
                {gi > 0 && <div style={{ height: 1, background: 'var(--border-subtle)', margin: '3px 0' }} />}
                {group.actions.map((item, ai) => (
                  <MenuItem
                    keyboardProps={itemProps(item.disabled, 'menuitem', item.hasSubmenu && (item.submenuRole || 'menu'))}
                    key={ai}
                    icon={item.icon}
                    label={item.label}
                    danger={item.danger}
                    disabled={item.disabled}
                    hasSubmenu={item.hasSubmenu}
                    onClick={() => {
                      if (item.disabled || !alive.current || !currentContext()) return;
                      item.action();
                      if (!item.keepOpen) onClose();
                    }}
                  />
                ))}
              </div>
            ))}
            <div style={{ height: 4 }} />
          </>
        )}
      </div>

      {headerMessage && !gmailKeyboard && (
        <MessageHeaderModal
          messageId={headerMessage.id}
          subject={headerMessage.subject}
          onClose={() => { setHeaderMessage(null); onClose(); }}
        />
      )}
    </>
  );
}

function MenuItem({ icon, label, onClick, danger, hasSubmenu, disabled, keyboardProps }) {
  const [hov, setHov] = useState(false);
  return (
    <div
      {...keyboardProps}
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '7px 14px', cursor: disabled ? 'default' : 'pointer',
        background: hov && !disabled ? (danger ? 'rgba(248,113,113,0.08)' : 'var(--bg-hover)') : 'transparent',
        color: disabled ? 'var(--text-tertiary)' : danger ? (hov ? 'var(--red)' : 'var(--text-secondary)') : 'var(--text-primary)',
        transition: 'background 0.08s, color 0.08s',
        fontSize: 13,
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <span style={{ flexShrink: 0, color: danger && hov ? 'var(--red)' : 'var(--text-tertiary)', display: 'flex' }}>
        {icon}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      {hasSubmenu && (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2.5">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      )}
    </div>
  );
}

function FolderMenuItem({ folder, icon: iconOverride, label, onClick, keyboardProps }) {
  const [hov, setHov] = useState(false);
  const su = (folder?.special_use || '').toLowerCase();
  const icon = iconOverride ? iconOverride
    : su.includes('sent')
    ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
    : su.includes('trash')
    ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
    : su.includes('draft')
    ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
    : su.includes('spam') || su.includes('junk')
    ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>;

  return (
    <div
      {...keyboardProps}
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '7px 14px', cursor: 'pointer',
        background: hov ? 'var(--bg-hover)' : 'transparent',
        color: 'var(--text-primary)',
        transition: 'background 0.08s',
        fontSize: 13,
      }}
    >
      <span style={{ flexShrink: 0, color: 'var(--text-tertiary)', display: 'flex' }}>{icon}</span>
      {folder ? <FolderPathLabel folder={folder} label={folder.favoriteLabel} /> : <FolderPathLabel label={label} />}
    </div>
  );
}

function menuNavigationKey(state) {
  return JSON.stringify([state.layout, state.selectedAccountId, state.selectedFolder, state.searchQuery,
    state.activeLabel, state.nativeLabelFeed?.key, state.nativeLabelFeed?.status, state.selectedMessageId]);
}

function visibleMenuOpener(opening) {
  const { opener, openerRow, openerRowId, openerOwnRowId } = opening;
  if (!opener?.isConnected || !opener.focus || opener.disabled
    || opener.dataset?.gmailRowId !== openerOwnRowId || openerRow?.dataset.gmailRowId !== openerRowId
    || opener.closest('[hidden], [inert], [aria-hidden="true"]') || !opener.getClientRects().length) return false;
  for (let element = opener; element; element = element.parentElement) {
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  }
  return true;
}
