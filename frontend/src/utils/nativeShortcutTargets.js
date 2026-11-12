import { topOpenMessageWindow } from './messageHotkeys.js';

export const NATIVE_TARGET_ACTIONS = new Set(['nextConversationMessage', 'prevConversationMessage']);

const isVisible = node => {
  for (let parent = node; parent; parent = parent.parentElement) {
    if (parent.hidden || parent.hasAttribute('inert') || parent.getAttribute('aria-hidden') === 'true' || parent.style.display === 'none') return false;
  }
  return true;
};

// Only a mounted, current reader/list may own these shortcuts. In particular, Tab must
// continue ordinary focus navigation from every interactive control and from the reader.
export function nativeShortcutTarget(action, state, root = document) {
  if (!NATIVE_TARGET_ACTIONS.has(action) || !state.user || state.isLocked || state.showContacts || state.showAdmin || state.composing || topOpenMessageWindow(state)) return null;
  if (!state.selectedMessageId || state.layout !== 'superhuman') return null;
  return [...root.querySelectorAll('[data-conversation-navigation]')].find(node =>
    node.dataset.conversationNavigation === String(state.selectedMessageId) && isVisible(node)) || null;
}

export function nativeTabTarget(event) {
  const target = event.target;
  if (event.key !== 'Tab') return true;
  // Do not take Tab from a focusable control, custom widget, or content outside the list.
  if (target?.closest?.('button, a[href], summary, input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"], [role="spinbutton"], [role="treeitem"]')) return false;
  const focusable = target?.closest?.('[tabindex]');
  if (focusable && !['list', 'listitem'].includes(focusable.getAttribute('role'))) return false;
  return target === document.body || Boolean(target?.closest?.('.sh-mail-list'));
}
