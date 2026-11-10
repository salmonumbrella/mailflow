import { folderRole } from './folderDisplay.js';

export function readerDeleteMode(message, accounts, folders) {
  const account = accounts.find(item => item.id === message.account_id);
  const folder = folders[message.account_id]?.find(item => item.path === message.folder) || { path: message.folder };
  const role = folderRole(folder, account?.folder_mappings);
  if (role === 'trash' || role === 'drafts' || message.is_draft) return 'permanent';
  // An unloaded/unknown folder may be Trash or Drafts on this account. Ask before
  // acting instead of claiming it is a recoverable move based on the selected folder.
  return role ? 'trash' : 'unknown';
}
