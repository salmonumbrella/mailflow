import { selectedMuteMessage } from './mutedThreads.js';
import { canDispatchHoveredGtdShortcut } from './gtdHoveredRow.js';
import { resolveGtdHotkeyTarget } from './gtdHotkeys.js';
import { selectedPickerMessage } from './labelPicker.js';
import { topOpenMessageWindow, focusedListMessage } from './messageHotkeys.js';

const SELECTED_ACTIONS = new Set([
  'markUnread', 'forward', 'replyAllFromSelection', 'unsubscribe',
  'loadRemoteImages', 'openLabelPicker', 'reply', 'replyAll',
  'toggleStar', 'printMessage', 'toggleRead', 'selectMessage', 'snooze', 'moveMessage',
]);

const WINDOW_ACTIONS = new Set([
  'reply', 'replyAll', 'forward', 'replyAllFromSelection', 'toggleStar',
  'printMessage', 'markUnread', 'openLabelPicker',
]);

export function canRunGlobalAction(action, { rightSidebarApplicable }) {
  return action !== 'toggleRightSidebar' || Boolean(rightSidebarApplicable);
}

export function canRunSelectedAction(action, state) {
  if (action === 'toggleThreadMute') return Boolean(selectedMuteMessage(state));
  if (canDispatchHoveredGtdShortcut(action, state)) return true;
  if (['gtdTodo', 'gtdWatch', 'gtdDelegated', 'gtdReference', 'gtdSomeday', 'gtdDone'].includes(action)) {
    return Boolean(resolveGtdHotkeyTarget(state));
  }
  if (!SELECTED_ACTIONS.has(action)) return true;
  const focused = focusedListMessage(state);
  if (focused && ['printMessage', 'unsubscribe', 'loadRemoteImages'].includes(action)) return false;
  if (!state?.selectedMessageId && !focused && !WINDOW_ACTIONS.has(action)) return false;
  return Boolean(selectedPickerMessage(state));
}

export function canHandlePaneShortcut(windowMessageId, state) {
  if (windowMessageId == null) return Boolean(state?.selectedMessageId);
  return topOpenMessageWindow(state)?.messageId === windowMessageId;
}
