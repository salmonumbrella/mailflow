import { canRunSelectedAction } from './shortcutApplicability.js';
import { selectedMessage, focusedListMessage } from './messageHotkeys.js';
import { labelPickerOptions } from './labelPicker.js';
import { getEffectiveShortcuts, modLabel, SPECIAL_KEY_LABELS } from './defaultShortcuts.js';

const MESSAGE_COMMANDS = new Set([
  'archive', 'snooze', 'toggleRead', 'markUnread', 'toggleStar', 'reply',
  'replyAll', 'forward', 'returnToInbox', 'delete', 'openLabelPicker', 'moveMessage',
]);

// The palette uses exactly the targets/actions owned by the existing mail UI.
export function canRunMailCommand(action, state) {
  if (state.composing || state.showAdmin || state.showContacts) return false;
  if (action === 'undoAction') return state.notifications?.some(item => typeof item.onUndo === 'function') ?? false;
  if (['filterUnread', 'filterStarred'].includes(action)) return canRunSelectedAction(action, state);
  if (!MESSAGE_COMMANDS.has(action)) return true;
  const message = selectedMessage(state);
  const account = state.accounts?.find(item => item.id === message?.account_id);
  if (!message || !account?.enabled || !canRunSelectedAction(action, state)) return false;
  // These handlers operate on the list selection, not a standalone pop-out.
  if (['archive', 'delete', 'snooze', 'moveMessage', 'toggleRead'].includes(action) && !state.selectedMessageId && !focusedListMessage(state)) return false;
  if (action === 'openLabelPicker') {
    const folders = state.folders?.[account.id];
    return !Array.isArray(folders) || labelPickerOptions(folders, account, message.folder).length > 0;
  }
  if (action === 'moveMessage') {
    const folders = state.folders?.[account.id];
    return !Array.isArray(folders) || folders.some(folder => folder.path && !folder.no_select && folder.path !== message.folder);
  }
  return true;
}

export function commandShortcutLabel(binding) {
  if (!binding) return '';
  return binding.split('+').map(part => part === 'ctrl' ? modLabel('ctrl')
    : part === 'shift' ? '⇧' : part === 'alt' ? 'Alt'
      : SPECIAL_KEY_LABELS[part] || part.toUpperCase()).join(' ');
}

export function mailCommandDefinitions(state, t) {
  const message = selectedMessage(state);
  const shortcuts = getEffectiveShortcuts(state.shortcuts, state.layout);
  const command = (action, label, detail = '', keywords = '') => ({
    id: `mail:${action}`, action, label, detail, keywords,
    shortcut: commandShortcutLabel(shortcuts[action]),
    disabled: !canRunMailCommand(action, state),
    targetId: MESSAGE_COMMANDS.has(action) ? message?.id : null,
  });
  const tr = (key, defaultValue) => t(key, { defaultValue });
  return [
    command('archive', tr('contextMenu.archive', 'Archive'), '', 'archive done'),
    command('snooze', tr('contextMenu.snooze.label', 'Snooze…'), '', 'remind later'),
    command('reply', tr('contextMenu.reply', 'Reply')),
    command('replyAll', tr('contextMenu.replyAll', 'Reply all')),
    command('forward', tr('contextMenu.forward', 'Forward')),
    command(message?.is_read ? 'markUnread' : 'toggleRead', message?.is_read ? tr('contextMenu.markUnread', 'Mark unread') : tr('contextMenu.markRead', 'Mark read')),
    command('toggleStar', message?.is_starred ? tr('contextMenu.unstar', 'Remove star') : tr('contextMenu.star', 'Star message')),
    command('openLabelPicker', tr('commandPalette.labelPicker.placeholder', 'Copy or label selected message…')),
    command('moveMessage', tr('contextMenu.folders.back', 'Move to folder…')),
    ...(state.layout === 'superhuman' ? [command('returnToInbox', tr('shortcuts.actions.returnToInbox.label', 'Return to Inbox')),
      ...['filterUnread', 'filterStarred'].map(action => command(action, tr(`shortcuts.actions.${action}.label`, action === 'filterUnread' ? 'Filter unread' : 'Filter starred')))] : []),
    command('delete', tr('contextMenu.delete', 'Delete'), '', 'trash'),
    command('undoAction', tr('shortcuts.actions.undoAction.label', 'Undo last action'), tr('shortcuts.actions.undoAction.description', 'Undo while its notification is available')),
    command('focusSearch', tr('messageList.search', 'Search mail'), '', 'find'),
    command('showHelp', tr('shortcuts.title', 'Keyboard shortcuts'), '', 'help keys'),
  ];
}
