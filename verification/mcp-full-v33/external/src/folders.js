// Folder roles as MailFlow's own rules see them (backend utils/mailUtils.js): the special-use
// flag first, then the stock names MailFlow recognises. MailFlow also honours each account's
// folder mappings, which API tokens cannot read, so this is a best guess; MailFlow's own checks
// on token requests back it up.

export const SNOOZED_FOLDER = 'Snoozed';

const SPECIAL_USE = {
  '\\inbox': 'inbox',
  '\\sent': 'sent',
  '\\drafts': 'drafts',
  '\\trash': 'trash',
  '\\junk': 'junk',
  '\\archive': 'archive',
  '\\all': 'all mail',
  '\\flagged': 'starred',
  '\\important': 'important',
};
const TRASH_NAMES = new Set(['trash', 'deleted', 'deleted items', 'deleted messages']);
const DRAFTS_NAMES = new Set(['drafts', 'draft']);
const SENT_NAMES = new Set(['sent', 'sent items', 'sent messages', 'sent mail']);
const SPAM_NAME = /(spam|junk|bulk|indesiderata|spamverdacht|courrier ind|posta indesiderata)/;
// MailFlow refuses token moves into these (and into folders that hold no mail).
const REFUSED_DESTINATIONS = new Set(['trash', 'junk', 'drafts', 'all mail', 'starred', 'important', 'snoozed']);
// Mail here is not "in the inbox" sense: archive and move skip it unless asked to include it.
export const NON_INBOX_ROLES = new Set(['sent', 'trash', 'junk', 'all mail', 'starred', 'important']);

export function isInboxPath(path) {
  return typeof path === 'string' && path.toUpperCase() === 'INBOX';
}

function topLevel(folder) {
  const name = String(folder.name ?? '');
  const path = String(folder.path ?? '');
  return path === name || path.toUpperCase() === `INBOX${folder.delimiter || ''}${name}`.toUpperCase();
}

export function folderRole(folder) {
  if (!folder) return null;
  if (isInboxPath(folder.path)) return { role: 'inbox', byName: false };
  if (folder.path === SNOOZED_FOLDER) return { role: 'snoozed', byName: false };
  const special = SPECIAL_USE[String(folder.special_use || '').toLowerCase()];
  if (special) return { role: special, byName: false };
  const name = String(folder.name || '').toLowerCase();
  if (topLevel(folder)) {
    if (TRASH_NAMES.has(name)) return { role: 'trash', byName: true };
    if (DRAFTS_NAMES.has(name)) return { role: 'drafts', byName: true };
    if (SENT_NAMES.has(name)) return { role: 'sent', byName: true };
  }
  if (SPAM_NAME.test(name)) return { role: 'junk', byName: true };
  if (name.includes('archive')) return { role: 'archive', byName: true };
  return null;
}

// Gmail's label views that MailFlow leaves out of its sync (imapManager.js, PROVIDERS.google
// skipFolderPatterns): rows appear in one only while the web client has it open, so listing or
// searching it shows an old snapshot, or nothing. MailFlow does this for Gmail accounts, known
// here by their [Gmail] or [Google Mail] folders, since a token cannot see an account's server.
const GMAIL_UNSYNCED = ['all mail', '[gmail]/starred', '[gmail]/important'];

export function isGmailFolderTree(folders) {
  return (folders || []).some(folder => /^\[(gmail|google mail)\](\/|$)/i.test(String(folder?.path ?? '')));
}

export function notSyncedByMailflow(folder, folders) {
  const path = String(folder?.path ?? '').toLowerCase();
  return isGmailFolderTree(folders) && GMAIL_UNSYNCED.some(pattern => path.includes(pattern));
}

// `folders` is the account's whole list, for the folders MailFlow does not sync.
export function refusedDestination(folder, folders) {
  if (folder?.no_select) return 'it is a container that holds no mail';
  const role = folderRole(folder)?.role;
  if (REFUSED_DESTINATIONS.has(role)) return `MailFlow refuses token moves into ${role === 'snoozed' ? 'Snoozed (use snooze instead)' : role}`;
  return notSyncedByMailflow(folder, folders) ? 'MailFlow refuses token moves into folders it does not sync' : null;
}

// A row's folder, looked up in its account's folder list when that loaded.
export function roleOfPath(path, folders) {
  const folder = folders?.find(entry => entry.path === path);
  if (folder) return folderRole(folder);
  const name = String(path || '').split(/[/.]/).pop();
  return folderRole({ path, name, special_use: null });
}

// Where MailFlow's archive most likely sends this account's mail. MailFlow prefers the account's
// archive mapping, which tokens cannot see; then special-use Archive, a folder named like
// "archive", and last Gmail-style All Mail.
export function predictArchiveFolder(folders) {
  const selectable = (folders || []).filter(folder => !folder.no_select);
  const special = value => folder => String(folder.special_use || '').toLowerCase() === value;
  return selectable.find(special('\\archive'))
    || selectable.find(folder => String(folder.name || '').toLowerCase().includes('archive'))
    || selectable.find(special('\\all'))
    || null;
}

// Folder paths go back to MailFlow exactly as they are, so one that a single display line would
// alter is shown JSON-quoted.
export function pathLabel(path) {
  const text = String(path ?? '');
  return /^[^\s"\\\u0000-\u001f\u007f]+(?: [^\s"\\\u0000-\u001f\u007f]+)*$/.test(text) ? text : JSON.stringify(text);
}
