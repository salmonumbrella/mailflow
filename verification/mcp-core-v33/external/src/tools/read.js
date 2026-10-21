import { z } from 'zod';
import {
  registerTool, textResult, uuidField, messageIdField, normalizeMessageId, CATEGORIES, READ_ONLY,
  messageFacts, messageSummary, listBlock, fitLines, RESULT_LIMIT, LOOKUP_CONCURRENCY, threadKey,
} from './shared.js';
import { loadAccounts, requireEnabledAccount, describeUnifiedScope, unifiedScope, accountNames } from '../accounts.js';
import { folderRole, refusedDestination, notSyncedByMailflow, isInboxPath, SNOOZED_FOLDER, pathLabel } from '../folders.js';
import {
  untrustedBlock, oneLine, truncate, bodyText, formatDate, formatBytes, formatCount, displayAddress,
  displayAddressList, accountLabel,
} from '../format.js';
import { mapSettled } from '../concurrency.js';
import { ToolError } from '../errors.js';

export const READ_MESSAGE_LIMIT = 40000;
export const READ_THREAD_LIMIT = 45000;
// The whole body fetch of read_thread finishes inside this, under the 50 s a client may wait.
export const THREAD_BODY_DEADLINE_MS = 45000;
const BODY_CONCURRENCY = 3;
// Listed first by list_folders, so a long list that has to be cut still shows these.
const ROLE_ORDER = ['inbox', 'sent', 'drafts', 'archive', 'trash', 'junk'];

const exactlyOneRef = value => (value.id === undefined) !== (value.messageId === undefined);
const ONE_REF = { error: 'Give exactly one of id or messageId', path: ['id'] };

const SEARCH_DESCRIPTION = [
  "Search the user's mail in MailFlow. All terms are ANDed; there is no OR, no parentheses and no bare phrase search.",
  'Operators: from:x (sender name or address contains x), to:x (To or Cc; Bcc is never searched), subject:x, has:attachment, is:unread, is:read, is:starred,',
  'after:YYYY-MM-DD (inclusive), before:YYYY-MM-DD (exclusive), in:<folder> (a loose folder-name match; in:all means every folder except Trash).',
  'A leading - negates from:, to:, subject:, has:, is:, after:, before: and words (-from:noreply, -invoice); quoted values may contain spaces (from:"Jane Doe").',
  'in: cannot be negated: MailFlow reads -in:x as in:x and searches only x, so a query with -in: is refused.',
  'Other words (2+ characters, at most 10) match the sender, subject and preview, and the body only where MailFlow has cached its text: Gmail accounts often have no cached bodies, so their bodies are mostly not searched.',
  'Without in: or folder every folder except Trash is searched, Junk included. To search one folder, prefer the folder parameter with the exact path from list_folders: in: matches names loosely and misses folders such as "Deleted Items".',
  'Without accountId it searches the unified inbox accounts and says which accounts that covered and which it skipped. A query of only in: (or of has:/is: values MailFlow does not know) finds nothing.',
].join(' ');

const NEGATED_IN = "MailFlow cannot leave a folder out of a search: it reads -in:x as in:x and searches only x. Leave in: out (every folder except Trash is searched) and check each result's folder, or search one folder with the folder parameter.";

// MailFlow's own reading of a query's operators (routes/search.js parseSearchQuery), so this
// server knows what MailFlow will make of a query: a value in quotes is one value, and a leading
// - right before an operator negates it, wherever it stands.
const SEARCH_OPERATOR = /(-?)\b(from|to|subject|has|is|after|before|in):("([^"]*)"|([\S]+))/gi;

export function searchFilters(query) {
  const filters = [];
  for (const match of String(query).matchAll(SEARCH_OPERATOR)) {
    const value = (match[4] !== undefined ? match[4] : (match[5] || '')).toLowerCase().trim();
    if (value) filters.push({ key: match[2].toLowerCase(), value, negate: match[1] === '-' });
  }
  return filters;
}

function attachmentLine(attachments) {
  // MailFlow lists here only parts the body does not show; one marked inline is still a file
  // (Apple Mail sends PDFs inline), so every entry is listed, as MailFlow's reading pane does.
  const list = (Array.isArray(attachments) ? attachments : []).filter(Boolean);
  if (!list.length) return null;
  const shown = list.slice(0, 20).map(item => {
    const name = oneLine(item.filename || '(unnamed)', 120);
    const type = oneLine(item.type || 'unknown type', 80);
    const inside = Array.isArray(item.contains) && item.contains.length
      ? `, contains ${item.contains.length} file${item.contains.length === 1 ? '' : 's'}`
      : '';
    return `${name} (${type}, ${formatBytes(item.size)}${inside})`;
  });
  const more = list.length > 20 ? `; and ${list.length - 20} more` : '';
  return `Attachments (${list.length}): ${shown.join('; ')}${more}`;
}

function known(value) {
  return value !== null && value !== undefined;
}

function folderCounts(folder) {
  if (folder.no_select) return null;
  if (known(folder.unread_count) && known(folder.total_count)) {
    return `${formatCount(folder.unread_count)} unread of ${formatCount(folder.total_count)}${folder.counts_stale ? ' (may be out of date)' : ''}`;
  }
  if (known(folder.cached_total_count)) {
    return `${formatCount(folder.cached_unread_count ?? 0)} unread of ${formatCount(folder.cached_total_count)} (cached by MailFlow; the mail server's count is not known yet)`;
  }
  return 'counts not known yet';
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function roleRank(folder) {
  const index = ROLE_ORDER.indexOf(folderRole(folder)?.role);
  return index === -1 ? ROLE_ORDER.length : index;
}

const lower = value => String(value ?? '').toLowerCase();

function nearFolder(list, folder) {
  const lowered = folder.toLowerCase();
  return list.find(entry => lower(entry.path) === lowered || lower(entry.name) === lowered);
}

// `lacks` says who lacks it: "<account> has no folder" or "None of the accounts searched has a folder".
function missingFolder(lacks, folder, near) {
  return new ToolError(`${lacks} ${JSON.stringify(folder)}.${near ? ` Did you mean ${pathLabel(near.path)}?` : ''} list_folders shows the exact paths.`);
}

const containerFolder = (folder, verb) => new ToolError(`${pathLabel(folder)} is a container that holds no mail; ${verb} one of its subfolders.`);

const unsyncedFolder = folder => new ToolError(
  `MailFlow does not keep ${pathLabel(folder)} in sync (it is one of Gmail's label views), so it would show an old snapshot or nothing. `
  + 'For starred mail use search_mail with is:starred; mail that is only in All Mail is not in MailFlow at all.',
);

// One account's folder that holds mail MailFlow keeps up to date. MailFlow itself matches the
// path exactly and answers an empty list for any other, which would read as "no mail".
async function requireFolder(client, account, folder, verb) {
  const folders = await client.listFolders(account.id);
  const list = Array.isArray(folders) ? folders : [];
  const match = list.find(entry => entry.path === folder);
  if (!match) throw missingFolder(`${accountLabel(account)} has no folder`, folder, nearFolder(list, folder));
  if (match.no_select) throw containerFolder(folder, verb);
  if (notSyncedByMailflow(match, list)) throw unsyncedFolder(folder);
  return match;
}

// Without accountId, the folder must be one that some account searched has.
async function requireSearchedFolder(client, accounts, folder) {
  const covered = unifiedScope(accounts).included;
  const results = await mapSettled(covered, LOOKUP_CONCURRENCY, account => client.listFolders(account.id));
  const matches = [];
  let near = null;
  let unchecked = null;
  for (const [index, result] of results.entries()) {
    if (!result.ok) {
      unchecked ??= `Could not check that ${accountLabel(covered[index])} has folder ${pathLabel(folder)}: ${result.error.message}`;
      continue;
    }
    const list = Array.isArray(result.value) ? result.value : [];
    const match = list.find(entry => entry.path === folder);
    if (match) matches.push({ match, list });
    else near ??= nearFolder(list, folder);
  }
  if (!matches.length && unchecked) throw new ToolError(unchecked);
  if (!matches.length) throw missingFolder('None of the accounts searched has a folder', folder, near);
  if (matches.every(({ match }) => match.no_select)) throw containerFolder(folder, 'search');
  if (matches.every(({ match, list }) => notSyncedByMailflow(match, list))) throw unsyncedFolder(folder);
}

export function registerReadTools(server, context) {
  registerTool(server, context, 'list_accounts', {
    title: 'List mail accounts',
    description: "List the user's MailFlow mail accounts: account_id, address, send-as aliases (alias_id), whether each is enabled and in the unified inbox, last sync and any sync error.",
    inputSchema: z.strictObject({}),
    annotations: READ_ONLY,
  }, async (_args, client) => {
    const accounts = await loadAccounts(client);
    if (!accounts.length) return textResult('This MailFlow user has no mail accounts.');
    const lines = [`${plural(accounts.length, 'MailFlow account')}. The unified inbox covers the accounts that are enabled and included in it.`, ''];
    accounts.forEach((account, index) => {
      const facts = [`account_id=${account.id}`, account.enabled === false ? 'disabled' : 'enabled'];
      if (account.enabled !== false) facts.push(account.include_in_unified_inbox === false ? 'not in the unified inbox' : 'in the unified inbox');
      if (account.last_sync) facts.push(`last sync ${formatDate(account.last_sync)}`);
      if (account.sync_error) facts.push(`sync error: ${oneLine(account.sync_error, 200)}`);
      const sendsAs = account.sender_name ? ` — sends as "${oneLine(account.sender_name, 80)}"` : '';
      lines.push(`[${index + 1}] ${accountLabel(account)}${sendsAs}`, `    ${facts.join(' · ')}`);
      for (const alias of account.aliases || []) {
        const replyTo = alias.reply_to ? ` (Reply-To ${oneLine(alias.reply_to, 254)})` : '';
        lines.push(`    alias_id=${alias.id} ${displayAddress(alias)}${replyTo}`);
      }
      const extras = [];
      if (account.auto_cc_addresses?.length) extras.push(`automatic Cc: ${account.auto_cc_addresses.map(a => oneLine(a, 254)).join(', ')}`);
      if (account.auto_bcc_addresses?.length) extras.push(`automatic Bcc: ${account.auto_bcc_addresses.map(a => oneLine(a, 254)).join(', ')}`);
      if (account.signature_enabled === false) extras.push('signature off by default');
      if (extras.length) lines.push(`    ${extras.join(' · ')}`);
    });
    return textResult(lines.join('\n'));
  });

  registerTool(server, context, 'list_folders', {
    title: 'List folders',
    description: "List one account's folders: the exact path to pass as `folder` to the other tools, the folder's role (inbox, sent, archive, …), unread and total counts, which folders MailFlow will not move mail into, and which it does not keep in sync. Inbox, Sent, Drafts, Archive, Trash and Junk come first; query finds folders by part of their path.",
    inputSchema: z.strictObject({
      accountId: uuidField('accountId').describe('account_id from list_accounts'),
      query: z.string().min(1).max(255).optional().describe('Only folders whose path contains this, in any case'),
    }),
    annotations: READ_ONLY,
  }, async ({ accountId, query }, client) => {
    const account = requireEnabledAccount(await loadAccounts(client), accountId);
    const folders = await client.listFolders(account.id);
    if (!Array.isArray(folders) || !folders.length) {
      return textResult(`${accountLabel(account)} has no folders in MailFlow yet (it may not have synced).`);
    }
    const wanted = query ? folders.filter(folder => lower(folder.path).includes(query.toLowerCase())) : folders;
    if (!wanted.length) {
      return textResult(`None of the ${plural(folders.length, 'folder')} of ${accountLabel(account)} (account_id=${account.id}) has ${JSON.stringify(query)} in its path.`);
    }
    const one = wanted.length === 1;
    const count = query
      ? `${wanted.length} of the ${plural(folders.length, 'folder')} of ${accountLabel(account)} (account_id=${account.id}) ${one ? 'has' : 'have'} ${JSON.stringify(query)} in ${one ? 'its' : 'their'} path.`
      : `${plural(folders.length, 'folder')} of ${accountLabel(account)} (account_id=${account.id}).`;
    const head = [
      `${count} Pass a path exactly as shown (JSON-quoted when it has unusual spacing). Counts are the mail server's own unless marked cached. Inbox, Sent, Drafts, Archive, Trash and Junk come first, then the rest by path.`,
      '',
    ];
    const lines = [...wanted].sort((a, b) => roleRank(a) - roleRank(b)).map(folder => {
      const parts = [];
      const role = folderRole(folder);
      if (role) parts.push(role.byName ? `${role.role} (by its name)` : role.role);
      const counts = folderCounts(folder);
      if (counts) parts.push(counts);
      if (notSyncedByMailflow(folder, folders)) parts.push('not kept in sync by MailFlow, so list_messages and search_mail cannot look inside it');
      const refused = refusedDestination(folder, folders);
      if (refused) parts.push(`not a move target: ${refused}`);
      return `${pathLabel(folder.path)}${parts.length ? ` — ${parts.join(' · ')}` : ''}`;
    });
    // Cut at a whole line, saying how many are left out, so a long list never ends unexplained.
    let used = head.join('\n').length;
    let shown = 0;
    for (; shown < lines.length; shown++) {
      if (used + lines[shown].length + 1 > RESULT_LIMIT - 300) break;
      used += lines[shown].length + 1;
    }
    const omitted = lines.length - shown;
    const tail = omitted ? ['', `${plural(omitted, 'more folder')} not shown, to keep the result small. list_folders with query finds a folder by part of its path.`] : [];
    return textResult([...head, ...lines.slice(0, shown), ...tail].join('\n'));
  });

  registerTool(server, context, 'list_messages', {
    title: 'List messages',
    description: 'List messages newest first (the Snoozed view soonest to come back first), one row per message: one folder of one account, or without accountId the unified inbox (the INBOX of every account in "All inboxes"). Without accountId only INBOX and Snoozed can be listed. Gives ids for the other tools; read_message shows a message in full.',
    inputSchema: z.strictObject({
      accountId: uuidField('accountId').optional().describe('account_id from list_accounts. Leave out for the unified inbox.'),
      folder: z.string().min(1).max(255).optional().describe('Exact folder path from list_folders; default INBOX. "Snoozed" lists snoozed mail (with accountId, that account\'s; without, every enabled account\'s).'),
      unreadOnly: z.boolean().optional().describe('Only unread messages'),
      category: z.enum(CATEGORIES).optional().describe('Only this MailFlow category (meaningful in INBOX)'),
      limit: z.number().int().min(1).max(100).default(25),
      offset: z.number().int().min(0).max(100000).default(0),
    }),
    annotations: READ_ONLY,
  }, async ({ accountId, folder: requested, unreadOnly, category, limit, offset }, client) => {
    const accounts = await loadAccounts(client);
    let folder = requested ?? 'INBOX';
    if (isInboxPath(folder)) folder = 'INBOX';
    if (/[\u0000-\u001f\u007f]/.test(folder)) throw new ToolError('folder must not contain control characters');
    const account = accountId ? requireEnabledAccount(accounts, accountId) : null;
    if (!account && folder !== 'INBOX' && folder !== SNOOZED_FOLDER) {
      throw new ToolError(`Listing ${JSON.stringify(folder)} needs accountId: without one, MailFlow lists only the unified INBOX or Snoozed. list_folders gives an account's exact paths.`);
    }
    if (account && folder !== 'INBOX' && folder !== SNOOZED_FOLDER) await requireFolder(client, account, folder, 'list');

    const result = await client.listMessages({ accountId: account?.id, folder, unreadOnly, category, limit, offset });
    const messages = Array.isArray(result?.messages) ? result.messages : [];
    const filters = [unreadOnly ? 'unread only' : null, category ? `category ${category}` : null].filter(Boolean);
    let scope;
    if (account) scope = `${accountLabel(account)} (account_id=${account.id}), folder ${pathLabel(folder)}.`;
    else if (folder === SNOOZED_FOLDER) scope = `Snoozed mail of all enabled accounts. ${describeUnifiedScope(accounts, { snoozed: true })}`;
    else scope = `Unified inbox (INBOX). ${describeUnifiedScope(accounts)}`;
    const lines = [`${scope}${filters.length ? ` Filter: ${filters.join(', ')}.` : ''}`];
    if (!messages.length) {
      lines.push(offset ? `No messages at offset ${offset}.` : 'No messages.');
      return textResult(lines.join('\n'));
    }
    const total = Number(result.total);
    const counted = Number.isFinite(total) && total > 0
      ? ` MailFlow counts ${formatCount(total)} ${unreadOnly ? 'unread ' : ''}in ${account ? 'this folder' : 'these folders'}${category ? ' (that count ignores the category filter)' : ''}.`
      : '';
    const more = messages.length === limit ? ` More may follow: offset=${offset + limit}.` : '';
    // MailFlow sorts the Snoozed view by when each message comes back.
    const order = folder === SNOOZED_FOLDER ? 'soonest to come back first' : 'newest first';
    lines.push(`${plural(messages.length, 'message')} from offset ${offset}, ${order}.${counted}${more}`, '');
    messages.forEach((message, index) => lines.push(`[${index + 1}] ${messageFacts(message, { folder: false })}`));
    const head = lines.join('\n');
    const block = listBlock(messages, message => messages.indexOf(message) + 1, RESULT_LIMIT - head.length - 200);
    return textResult(`${head}\n\n${untrustedBlock(block.text)}`);
  });

  registerTool(server, context, 'search_mail', {
    title: 'Search mail',
    description: SEARCH_DESCRIPTION,
    inputSchema: z.strictObject({
      query: z.string().min(1).max(500).describe('MailFlow search query, e.g. from:amazon invoice after:2026-01-01'),
      accountId: uuidField('accountId').optional().describe('Search only this account (account_id from list_accounts)'),
      folder: z.string().min(1).max(255).optional().describe('Exact folder path from list_folders. MailFlow ignores it when the query has in:.'),
      limit: z.number().int().min(1).max(100).default(25),
      offset: z.number().int().min(0).max(100000).default(0),
    }),
    annotations: READ_ONLY,
  }, async ({ query, accountId, folder: requested, limit, offset }, client) => {
    const q = query.trim();
    if (!q) throw new ToolError('query must not be blank');
    const filters = searchFilters(q);
    if (filters.some(filter => filter.key === 'in' && filter.negate)) throw new ToolError(NEGATED_IN);
    const hasIn = filters.some(filter => filter.key === 'in');
    let folder = requested;
    if (folder !== undefined) {
      if (/[\u0000-\u001f\u007f]/.test(folder)) throw new ToolError('folder must not contain control characters');
      if (isInboxPath(folder)) folder = 'INBOX';
    }
    const accounts = await loadAccounts(client);
    const account = accountId ? requireEnabledAccount(accounts, accountId) : null;
    if (!account && !unifiedScope(accounts).included.length) {
      throw new ToolError('No account is in the unified inbox, so a search without accountId would cover nothing; give accountId.');
    }
    // MailFlow matches the folder exactly, and a path it does not have finds nothing, which would
    // read as "nothing matched". With in: in the query it ignores the folder.
    if (folder !== undefined && !hasIn && folder !== 'INBOX' && folder !== SNOOZED_FOLDER) {
      if (account) await requireFolder(client, account, folder, 'search');
      else await requireSearchedFolder(client, accounts, folder);
    }
    const result = await client.search({ q, accountId: account?.id, folder, limit, offset });
    const messages = Array.isArray(result?.messages) ? result.messages : [];
    const scope = account
      ? `Searched ${accountLabel(account)} (account_id=${account.id}).`
      : describeUnifiedScope(accounts, { verb: 'Searched' });
    let folderNote = '';
    if (folder) folderNote = hasIn ? ` The query has in:, so MailFlow ignored folder ${pathLabel(folder)}.` : ` Folder: ${pathLabel(folder)}.`;
    const lines = [`${scope}${folderNote}`];
    if (!messages.length) {
      lines.push(offset ? `No more results at offset ${offset}.` : 'No messages matched.');
      return textResult(lines.join('\n'));
    }
    const more = messages.length === limit ? ` More may follow: offset=${offset + limit}.` : '';
    lines.push(`${plural(messages.length, 'result')} from offset ${offset}, newest first.${more}`);
    const names = accountNames(accounts);
    const used = [...new Set(messages.map(message => lower(message.account_id)))];
    lines.push(`Accounts: ${used.map(id => `account_id=${id} is ${names.get(id) || 'an account not in list_accounts'}`).join('; ')}.`, '');
    messages.forEach((message, index) => lines.push(`[${index + 1}] ${messageFacts(message)}`));
    const head = lines.join('\n');
    const block = listBlock(messages, message => messages.indexOf(message) + 1, RESULT_LIMIT - head.length - 200);
    return textResult(`${head}\n\n${untrustedBlock(block.text)}`);
  });

  registerTool(server, context, 'read_message', {
    title: 'Read a message',
    description: 'Read one message: headers, attachment names and sizes, and the body as plain text (HTML is converted to text; links are listed, images are never loaded). Identify it by id (from list_messages, search_mail or read_thread) or by messageId, the RFC Message-ID that survives moves; add accountId when the same mail is in two accounts. Reading does not mark it read.',
    inputSchema: z.strictObject({
      id: uuidField('id').optional().describe('MailFlow message id'),
      messageId: messageIdField.optional().describe('RFC Message-ID such as <abc@example.com> (brackets optional)'),
      accountId: uuidField('accountId').optional().describe('With messageId: the account to look in'),
      maxChars: z.number().int().min(1000).max(READ_MESSAGE_LIMIT).default(20000).describe('Most body characters to return'),
    }).refine(exactlyOneRef, ONE_REF),
    annotations: READ_ONLY,
  }, async ({ id, messageId, accountId, maxChars }, client) => {
    const row = id
      ? await client.getMessage(id.toLowerCase())
      : await client.resolveMessage(normalizeMessageId(messageId), accountId?.toLowerCase());
    if (id && accountId && lower(row.account_id) !== accountId.toLowerCase()) {
      throw new ToolError(`Message id=${row.id} belongs to account_id=${row.account_id}, not ${accountId}.`);
    }
    let body = null;
    let bodyError = null;
    try {
      body = await client.getMessageBody(row.id);
    } catch (err) {
      bodyError = err;
    }

    const flags = [row.is_read ? 'read' : 'unread'];
    if (row.is_starred) flags.push('starred');
    if (row.category && CATEGORIES.includes(row.category)) flags.push(`category ${row.category}`);
    if (row.spam_verdict === 'spam' && !known(row.spam_user_override)) flags.push("MailFlow's spam filter rates it as spam");
    const account = accountLabel({ name: row.account_name, email_address: row.account_email, id: row.account_id });
    const trusted = [
      `Message id=${row.id} account_id=${row.account_id} (${account})`,
      `Folder ${pathLabel(row.folder)} · ${formatDate(row.date)} · ${flags.join(' · ')}`,
      `Its id changes if it is moved or archived; find it again with read_message { messageId: <its Message-ID below>, accountId: "${row.account_id}" }.`,
    ];

    const headers = [`From: ${displayAddress({ name: row.from_name, email: row.from_email }) || '(unknown sender)'}`];
    if (body?.senderEmail && lower(body.senderEmail) !== lower(row.from_email || '')) {
      headers.push(`Sender: ${displayAddress({ name: body.senderName, email: body.senderEmail })}`);
    }
    headers.push(`To: ${displayAddressList(row.to_addresses) || '(none)'}`);
    const cc = displayAddressList(row.cc_addresses);
    if (cc) headers.push(`Cc: ${cc}`);
    const replyTo = displayAddressList(row.reply_to, 5);
    if (replyTo) headers.push(`Reply-To: ${replyTo}`);
    if (Array.isArray(body?.bccAddresses) && body.bccAddresses.length) headers.push(`Bcc: ${displayAddressList(body.bccAddresses)}`);
    headers.push(`Subject: ${oneLine(row.subject, 500) || '(no subject)'}`);
    if (row.message_id) headers.push(`Message-ID: ${oneLine(row.message_id, 1000)}`);
    if (body?.forwardedFromEmail) headers.push(`Forwarded from: ${displayAddress({ name: body.forwardedFromName, email: body.forwardedFromEmail })}`);
    const attachments = attachmentLine(body?.attachments);
    if (attachments) headers.push(attachments);
    const headerBlock = headers.join('\n');

    if (bodyError) {
      const text = [...trusted, '', untrustedBlock(headerBlock), '', `The headers loaded but the body did not: ${bodyError.message}`].join('\n');
      return textResult(text, { isError: true });
    }

    const head = trusted.join('\n');
    const budget = Math.max(1000, Math.min(maxChars, READ_MESSAGE_LIMIT - head.length - headerBlock.length - 800));
    const content = bodyText(body, budget);
    const cut = truncate(content.text, budget);
    const lines = [head];
    if (content.source === 'html') lines.push('The body below was converted from HTML: links are shown in parentheses and no images were loaded.');
    lines.push('', untrustedBlock(`${headerBlock}\n\n${cut.text || '(no body text: the message may be empty, or no longer on the mail server)'}`));
    if (cut.truncated || !content.complete) {
      const of = content.complete ? ` of ${formatCount(cut.total)}` : '';
      const again = maxChars < READ_MESSAGE_LIMIT ? ` Call read_message again with a larger maxChars (up to ${formatCount(READ_MESSAGE_LIMIT)}) for more.` : '';
      lines.push(`The body was cut to its first ${formatCount(cut.text.length)}${of} characters.${again}`);
    }
    return textResult(lines.join('\n'));
  });

  registerTool(server, context, 'read_thread', {
    title: 'Read a conversation',
    description: "Read a whole conversation in one account: every message MailFlow groups with this one in its account, across that account's folders (each shown with its folder and whether it is a draft), oldest first, with the bodies of the newest few. Identify it by id or messageId (add accountId with messageId when the mail is in two accounts). The same email in another of the user's accounts is a separate copy there; allAccounts: true lists those copies too.",
    inputSchema: z.strictObject({
      id: uuidField('id').optional().describe('MailFlow id of any message in the conversation'),
      messageId: messageIdField.optional().describe('RFC Message-ID of any message in it'),
      accountId: uuidField('accountId').optional().describe('With messageId: the account to look in'),
      maxMessages: z.number().int().min(1).max(50).default(20).describe('List at most this many, the newest'),
      withBodies: z.number().int().min(0).max(10).default(3).describe('Include the bodies of this many of the newest messages'),
      maxCharsPerMessage: z.number().int().min(500).max(20000).default(6000),
      allAccounts: z.boolean().default(false).describe("Also list the conversation's copies in the user's other accounts"),
    }).refine(exactlyOneRef, ONE_REF),
    annotations: READ_ONLY,
  }, async ({ id, messageId, accountId, maxMessages, withBodies, maxCharsPerMessage, allAccounts }, client) => {
    // resolve-message also accepts a row id, and unlike GET /messages/:id it returns thread_id.
    const anchor = await client.resolveMessage(id ? id.toLowerCase() : normalizeMessageId(messageId), accountId?.toLowerCase());
    const thread = await client.getThread(threadKey(anchor));
    // MailFlow lists the conversation in every enabled account: one email delivered to two
    // accounts is a message in each. Unless asked, only the account of the message asked about
    // is shown, so acting on "the conversation" never reaches another account's copies.
    const everywhere = Array.isArray(thread?.messages) ? thread.messages : [];
    const sameAccount = message => lower(message.account_id) === lower(anchor.account_id);
    let all = allAccounts ? everywhere : everywhere.filter(sameAccount);
    if (!all.length) all = [anchor];
    const elsewhere = allAccounts ? 0 : everywhere.filter(message => !sameAccount(message)).length;
    const shown = all.slice(-maxMessages);
    const skippedOlder = all.length - shown.length;
    const withBody = withBodies > 0 ? shown.slice(-withBodies) : [];
    const number = message => skippedOlder + shown.indexOf(message) + 1;

    const deadline = AbortSignal.timeout(THREAD_BODY_DEADLINE_MS);
    const results = await mapSettled(withBody, BODY_CONCURRENCY, message => client.getMessageBody(message.id, { signal: deadline }));
    const bodies = new Map(withBody.map((message, i) => [message, results[i]]));

    const folderCount = new Set(shown.map(message => message.folder)).size;
    const accountCount = new Set(shown.map(message => lower(message.account_id))).size;
    const otherCopies = elsewhere
      ? ` Not listed: ${plural(elsewhere, 'message')} of it in the user's other accounts (allAccounts: true lists them).`
      : '';
    const trusted = [
      `Conversation of id=${anchor.id} (account_id=${anchor.account_id}): ${plural(all.length, 'message')} in ${plural(folderCount, 'folder')}${accountCount > 1 ? ` across ${accountCount} accounts` : ''}, oldest first.${skippedOlder ? ` Showing the newest ${shown.length}.` : ''}${withBody.length ? ` Bodies of the newest ${withBody.length} are included.` : ''}${otherCopies}`,
      '',
    ];
    for (const message of shown) {
      const notes = `${message.id === anchor.id ? ' (the message asked about)' : ''}${sameAccount(message) ? '' : ' (another account)'}`;
      trusted.push(`[${number(message)}] ${messageFacts(message)}${notes}`);
    }
    const failed = withBody.filter(message => !bodies.get(message).ok);
    if (failed.length) trusted.push('', `Bodies not loaded: ${failed.map(message => `[${number(message)}] ${bodies.get(message).error.message}`).join('; ')}`);
    const head = trusted.join('\n');

    const summaries = shown.map(message => {
      const to = displayAddressList(message.to_addresses, 5);
      return `[${number(message)}] ${messageSummary(message, { snippet: !bodies.has(message) })}${to ? ` | To: ${oneLine(to, 400)}` : ''}`;
    });
    const room = READ_THREAD_LIMIT - head.length - 400;
    const list = fitLines(summaries, Math.floor(room / 2));
    const perBody = withBody.length
      ? Math.max(500, Math.min(maxCharsPerMessage, Math.floor((room - list.text.length) / withBody.length) - 120))
      : 0;
    const parts = [list.text];
    let cutAny = false;
    for (const message of withBody) {
      const result = bodies.get(message);
      if (!result.ok) {
        parts.push(`--- [${number(message)}] body not loaded ---`);
        continue;
      }
      const content = bodyText(result.value, perBody);
      const cut = truncate(content.text, perBody);
      const shortened = cut.truncated || !content.complete;
      if (shortened) cutAny = true;
      parts.push(`--- [${number(message)}] body${content.source === 'html' ? ' (converted from HTML)' : ''} ---\n${cut.text || '(no body text)'}${shortened ? '\n[cut]' : ''}`);
    }
    const block = fitLines(parts, room);
    const notes = [];
    if (cutAny) notes.push(`Bodies marked [cut] were shortened to about ${formatCount(perBody)} characters; read_message shows one in full.`);
    return textResult([head, '', untrustedBlock(block.text), ...notes].join('\n'));
  });

  registerTool(server, context, 'unread_counts', {
    title: 'Unread counts',
    description: "Unread messages in each enabled account's INBOX as last counted on the mail servers, the unified inbox total, how many messages are snoozed, and unread INBOX mail per MailFlow category.",
    inputSchema: z.strictObject({}),
    annotations: READ_ONLY,
  }, async (_args, client) => {
    const [accounts, counts, categories] = await Promise.all([
      loadAccounts(client),
      client.unreadCounts(),
      client.categoryCounts().catch(err => ({ error: err })),
    ]);
    const lines = ['Unread mail in INBOX, as last counted on the mail servers:'];
    for (const account of accounts.filter(entry => entry.enabled !== false)) {
      const value = counts?.byAccount?.[account.id];
      const stale = known(value) && counts?.snapshots?.[account.id]?.stale ? ' (may be out of date)' : '';
      const count = known(value) ? `${formatCount(value)} unread${stale}` : 'unknown (not counted yet)';
      const unified = account.include_in_unified_inbox === false ? ' · not in the unified inbox' : '';
      lines.push(`- ${accountLabel(account)} (account_id=${account.id}): ${count}${unified}`);
    }
    const disabled = accounts.filter(entry => entry.enabled === false);
    if (disabled.length) lines.push(`Disabled accounts are not counted: ${disabled.map(account => accountLabel(account)).join(', ')}.`);
    lines.push(`Unified inbox: ${formatCount(counts?.total ?? 0)} unread${counts?.complete === false ? ' (some accounts are not counted yet or may be out of date)' : ''}.`);
    lines.push(`Snoozed: ${plural(Number(counts?.snoozed ?? 0), 'message')}.`);
    if (categories?.error) {
      lines.push(`Category counts did not load: ${categories.error.message}`);
    } else if (categories?.counts) {
      lines.push(`Unread in the unified inbox by category (from MailFlow's cache): ${CATEGORIES.map(name => `${name} ${formatCount(categories.counts[name] ?? 0)}`).join(' · ')}.`);
    }
    return textResult(lines.join('\n'));
  });

  registerTool(server, context, 'find_contacts', {
    title: 'Find contacts',
    description: "Look up email addresses by part of a name or address, among the user's contacts and the people who have written to them (at most 10). Use it to address drafts.",
    inputSchema: z.strictObject({
      query: z.string().min(2).max(100).describe('Part of a name or address'),
    }),
    annotations: READ_ONLY,
  }, async ({ query }, client) => {
    const q = query.trim();
    if (q.length < 2) throw new ToolError('query needs at least 2 characters');
    const result = await client.searchContacts(q);
    const contacts = Array.isArray(result?.contacts) ? result.contacts : [];
    if (!contacts.length) return textResult('No contacts matched.');
    const lines = contacts.map(contact => `- ${displayAddress(contact) || '(no address)'}`);
    return textResult(`${plural(contacts.length, 'contact')} matched (MailFlow returns at most 10):\n${untrustedBlock(lines.join('\n'))}`);
  });
}
