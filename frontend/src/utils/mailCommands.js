import { canRunSelectedAction } from './shortcutApplicability.js';
import { selectedMessage, focusedListMessage } from './messageHotkeys.js';
import { labelPickerOptions } from './labelPicker.js';
import { getEffectiveShortcuts, modLabel, SPECIAL_KEY_LABELS } from './defaultShortcuts.js';

const MESSAGE_COMMANDS = new Set([
  'archive', 'snooze', 'toggleRead', 'markUnread', 'toggleStar', 'reply',
  'replyAll', 'forward', 'delete', 'openLabelPicker', 'moveMessage', 'toggleThreadMute',
]);

// The palette uses exactly the targets/actions owned by the existing mail UI.
export function canRunMailCommand(action, state) {
  if (state.composing || state.showAdmin || state.showContacts) return false;
  if (action === 'undoAction') return state.notifications?.some(item => typeof item.onUndo === 'function') ?? false;
  if (!MESSAGE_COMMANDS.has(action)) return true;
  const message = selectedMessage(state);
  const account = state.accounts?.find(item => item.id === message?.account_id);
  if (!message || !account?.enabled || !canRunSelectedAction(action, state)) return false;
  // These handlers operate on the list selection, not a standalone pop-out.
  if (['archive', 'delete', 'snooze', 'moveMessage', 'toggleRead'].includes(action) && !state.selectedMessageId && !focusedListMessage(state)) return false;
  if (action === 'openLabelPicker') {
    return labelPickerOptions(state.folders?.[account.id], account, message.folder).length > 0;
  }
  if (action === 'moveMessage') {
    return state.folders?.[account.id]?.some(folder => folder.path && !folder.no_select && folder.path !== message.folder) ?? false;
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
  const tr = (name, defaultValue) => t(`commandPalette.mail.${name}`, { defaultValue });
  return [
    command('archive', state.layout === 'superhuman' ? tr('done', 'Done') : tr('archive', 'Archive'), tr('archiveDetail', 'Archive using your account’s Archive folder'), 'archive'),
    command('snooze', tr('snooze', 'Snooze…'), tr('snoozeDetail', 'Choose when this message returns'), 'remind later'),
    command('reply', tr('reply', 'Reply')),
    command('replyAll', tr('replyAll', 'Reply all')),
    command('forward', tr('forward', 'Forward')),
    command(message?.is_read ? 'markUnread' : 'toggleRead', message?.is_read ? tr('markUnread', 'Mark unread') : tr('markRead', 'Mark read')),
    command('toggleStar', message?.is_starred ? tr('unstar', 'Remove star') : tr('star', 'Star message'), '', 'important'),
    command('openLabelPicker', tr('label', 'Label or copy to folder…')),
    command('moveMessage', tr('move', 'Move to folder…')),
    command('toggleThreadMute', t('mutedThreads.actionDescription', 'Mute or unmute the selected conversation'), t('mutedThreads.description', 'Muted conversations stay in MailFlow. New-mail alerts for matching messages are silenced. Muting archives the current inbox conversation; unmuting does not move it back.'), 'mute silence'),
    command('delete', tr('delete', 'Delete message'), tr('deleteDetail', 'Drafts and messages already in Trash are permanently deleted'), 'trash'),
    command('undoAction', tr('undo', 'Undo last action'), tr('undoDetail', 'Undo while its notification is available')),
    command('focusSearch', tr('search', 'Search mail'), '', 'find'),
    command('showHelp', tr('help', 'Keyboard shortcuts'), '', 'help keys'),
  ];
}
