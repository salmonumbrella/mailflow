import { z } from 'zod';
import {
  registerTool, textResult, uuidField, idsField, uniqueIds, CATEGORIES, loadRows, NOT_FOUND_REASON,
  LOOKUP_CONCURRENCY, isNotFound, messageSummary, fitLines, RESULT_LIMIT,
} from './shared.js';
import { loadAccounts, requireEnabledAccount } from '../accounts.js';
import { roleOfPath, predictArchiveFolder, NON_INBOX_ROLES, SNOOZED_FOLDER, pathLabel } from '../folders.js';
import { untrustedBlock, formatDate, accountLabel } from '../format.js';
import { mapSettled } from '../concurrency.js';
import { MailflowError } from '../mailflowClient.js';
import { ToolError } from '../errors.js';

// Archive and move load every row first; MailFlow itself takes up to 500, this keeps it reviewable.
const MAX_MOVE_IDS = 50;
const MAX_FLAG_IDS = 100;
const MAX_SNOOZE_DAYS = 30;

const CHANGE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ONE_WAY = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
// Archive and move both give the messages new ids, so the ones the caller holds stop working.
const RELOCATE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const INCLUDE_NON_INBOX = z.boolean().default(false)
  .describe('Also act on messages in Sent, Trash, Junk and similar folders, which are skipped by default. Drafts and snoozed mail are always skipped.');

function nameOfRole(role) {
  return { sent: 'Sent', trash: 'Trash', junk: 'Junk', 'all mail': 'All Mail', starred: 'Starred', important: 'Important' }[role] || role;
}

// Why a loaded row (see loadRows) is not archived or moved, or null to go ahead.
function skipReason(entry, folders, includeNonInbox) {
  const { row } = entry;
  const role = roleOfPath(row.folder, folders)?.role;
  if (entry.isDraft || role === 'drafts') return 'a draft (this tool never moves or archives drafts)';
  if (entry.draftCheckError) return `could not check whether it is a draft, so it was left alone: ${entry.draftCheckError.message}`;
  if (role === 'snoozed' || row.folder === SNOOZED_FOLDER) return 'snoozed (unsnooze it first)';
  if (role && NON_INBOX_ROLES.has(role) && !includeNonInbox) {
    return `in ${nameOfRole(role)} (${pathLabel(row.folder)}); pass includeNonInbox: true to include it`;
  }
  return null;
}

async function loadFolderLists(client, accountIds) {
  const results = await mapSettled(accountIds, LOOKUP_CONCURRENCY, id => client.listFolders(id));
  return new Map(accountIds.map((id, i) => [id, results[i].ok && Array.isArray(results[i].value) ? results[i].value : null]));
}

function lower(value) {
  return String(value ?? '').toLowerCase();
}

// For ids a bulk flag change left alone: was it already so, or is it gone?
async function explainUnchanged(client, ids, alreadyThere, alreadyText) {
  const results = await mapSettled(ids, LOOKUP_CONCURRENCY, id => client.getMessage(id));
  return ids.map((id, i) => {
    const result = results[i];
    if (result.ok) {
      return alreadyThere(result.value)
        ? { id, reason: alreadyText, already: true }
        : { id, reason: 'MailFlow left it unchanged (the mail server may have refused it; try again later)' };
    }
    if (isNotFound(result.error)) return { id, reason: NOT_FOUND_REASON };
    return { id, reason: `could not check it: ${result.error.message}` };
  });
}

function flagTool({ name, title, description, field, labels, isSet, call }) {
  return {
    name,
    config: {
      title,
      description,
      inputSchema: z.strictObject({
        ids: idsField(MAX_FLAG_IDS).describe('Message ids (from list_messages, search_mail or read_thread)'),
        [field]: z.boolean().describe(labels.describe),
      }),
      annotations: CHANGE,
    },
    async run(client, args) {
      const ids = uniqueIds(args.ids);
      const value = args[field];
      const result = await call(client, ids, value);
      const updated = new Set((Array.isArray(result?.updated) ? result.updated : []).map(lower));
      const changed = ids.filter(id => updated.has(id));
      const left = ids.filter(id => !updated.has(id));
      const reasons = left.length
        ? await explainUnchanged(client, left, row => Boolean(row[isSet]) === value, value ? labels.alreadyOn : labels.alreadyOff)
        : [];
      const lines = [`${value ? labels.on : labels.off}: ${changed.length} of ${ids.length} message${ids.length === 1 ? '' : 's'} changed.`];
      if (changed.length) lines.push(`Changed: ${changed.map(id => `id=${id}`).join(', ')}`);
      if (reasons.length) {
        lines.push('Not changed:');
        for (const entry of reasons) lines.push(`  id=${entry.id} — ${entry.reason}`);
      }
      const nothingHappened = !changed.length && reasons.some(entry => !entry.already);
      return textResult(lines.join('\n'), { isError: nothingHappened });
    },
  };
}

function relocationReport({ verb, requested, acted, skipped, failed, destination }) {
  const lines = [`${verb} ${acted.length} of ${requested} message${requested === 1 ? '' : 's'}.`];
  if (acted.length) {
    lines.push('Their ids have changed: find one again with read_message { messageId, accountId } (Message-IDs are in the block below).');
    acted.forEach((row, index) => {
      lines.push(`  [${index + 1}] was id=${row.id} · account_id=${row.account_id} · from ${pathLabel(row.folder)} → ${destination(row)}`);
    });
  }
  const not = [...skipped, ...failed];
  if (not.length) {
    lines.push(`Not ${verb.toLowerCase()}:`);
    for (const entry of not) lines.push(`  id=${entry.id} — ${entry.reason}`);
  }
  let text = fitLines(lines, RESULT_LIMIT - 8000).text;
  if (acted.length) {
    const summaries = acted.map((row, index) => `[${index + 1}] ${messageSummary(row, { snippet: false })}`);
    text += `\n\n${untrustedBlock(fitLines(summaries, 7000).text)}`;
  }
  return text;
}

export function registerOrganizeTools(server, context) {
  const flags = [
    flagTool({
      name: 'mark_read',
      title: 'Mark read or unread',
      description: 'Mark messages read (read: true) or unread (read: false), in MailFlow and on the mail server. Reports which ids changed and why any did not.',
      field: 'read',
      labels: { describe: 'true marks them read, false unread', on: 'Marked read', off: 'Marked unread', alreadyOn: 'already read', alreadyOff: 'already unread' },
      isSet: 'is_read',
      call: (c, ids, value) => c.bulkRead(ids, value),
    }),
    flagTool({
      name: 'star',
      title: 'Star or unstar',
      description: 'Star (starred: true) or unstar (starred: false) messages, in MailFlow and on the mail server (the Flagged flag). Reports which ids changed and why any did not.',
      field: 'starred',
      labels: { describe: 'true stars them, false removes the star', on: 'Starred', off: 'Unstarred', alreadyOn: 'already starred', alreadyOff: 'already not starred' },
      isSet: 'is_starred',
      call: (c, ids, value) => c.bulkStar(ids, value),
    }),
  ];
  for (const tool of flags) registerTool(server, context, tool.name, tool.config, (args, client) => tool.run(client, args));

  registerTool(server, context, 'archive', {
    title: 'Archive',
    description: [
      "Move messages to each one's account archive folder. MailFlow picks it: the account's archive mapping, else a folder flagged or named Archive.",
      'On a Gmail account with neither, MailFlow refuses the whole request, because the mail would go to All Mail and drop out of MailFlow:',
      "archive the other accounts' messages on their own, and suggest the user create a Gmail label named Archive.",
      'Ids change: the result lists each message\'s Message-ID and account so you can find it again. Drafts, snoozed mail, and mail in Sent, Trash or Junk',
      '(unless includeNonInbox) are skipped and listed with the reason. To archive a conversation, pass only its INBOX messages in that account. At most 50 ids.',
    ].join(' '),
    inputSchema: z.strictObject({
      ids: idsField(MAX_MOVE_IDS).describe('Message ids to archive'),
      includeNonInbox: INCLUDE_NON_INBOX,
    }),
    annotations: RELOCATE,
  }, async ({ ids: requestedIds, includeNonInbox }, client) => {
    const ids = uniqueIds(requestedIds);
    const loaded = await loadRows(client, ids);
    const accountIds = [...new Set(loaded.filter(entry => entry.row).map(entry => lower(entry.row.account_id)))];
    const folderLists = await loadFolderLists(client, accountIds);
    const skipped = [];
    const act = [];
    for (const entry of loaded) {
      if (entry.missing) { skipped.push({ id: entry.id, reason: NOT_FOUND_REASON }); continue; }
      if (entry.error) { skipped.push({ id: entry.id, reason: `could not load it: ${entry.error.message}` }); continue; }
      const folders = folderLists.get(lower(entry.row.account_id));
      const reason = skipReason(entry, folders, includeNonInbox);
      if (reason) { skipped.push({ id: entry.id, reason }); continue; }
      const archive = predictArchiveFolder(folders);
      if (archive && archive.path === entry.row.folder) { skipped.push({ id: entry.id, reason: 'already in the archive folder' }); continue; }
      act.push(entry.row);
    }
    if (!act.length) return textResult(relocationReport({ verb: 'Archived', requested: ids.length, acted: [], skipped, failed: [], destination: () => '' }), { isError: true });

    let result;
    try {
      result = await client.bulkArchive(act.map(row => row.id));
    } catch (err) {
      const text = relocationReport({ verb: 'Archived', requested: ids.length, acted: [], skipped, failed: [], destination: () => '' });
      const note = err instanceof MailflowError && err.mayHaveCompleted ? ' Check with search_mail or read_message by Message-ID before trying again.' : '';
      return textResult(`${text}\nThe archive request failed: ${err.message}${note}`, { isError: true });
    }
    const archived = new Set((Array.isArray(result?.archived) ? result.archived : []).map(lower));
    const noFolder = new Set((Array.isArray(result?.noArchiveFolder) ? result.noArchiveFolder : []).map(lower));
    const done = act.filter(row => archived.has(lower(row.id)));
    const failed = act.filter(row => !archived.has(lower(row.id))).map(row => ({
      id: row.id,
      reason: noFolder.has(lower(row.account_id))
        ? `its account (account_id=${row.account_id}) has no archive folder MailFlow can find`
        : 'MailFlow did not archive it (it may have been moved meanwhile, or the mail server refused the move)',
    }));
    const destination = row => {
      const target = predictArchiveFolder(folderLists.get(lower(row.account_id)));
      return target ? `the archive folder (most likely ${pathLabel(target.path)})` : 'the archive folder';
    };
    const text = relocationReport({ verb: 'Archived', requested: ids.length, acted: done, skipped, failed, destination });
    return textResult(text, { isError: done.length === 0 });
  });

  registerTool(server, context, 'move_messages', {
    title: 'Move messages',
    description: [
      'Move messages into another folder of the same account (accountId), using the exact path from list_folders.',
      'MailFlow refuses token moves into Trash, Junk, Drafts, All Mail, Starred and Snoozed, and into folders it does not sync; there is no delete.',
      "Ids change: the result lists each message's Message-ID so you can find it again. Messages of other accounts, drafts, snoozed mail,",
      'mail already in that folder, and mail in Sent, Trash or Junk (unless includeNonInbox) are skipped and listed with the reason. At most 50 ids.',
    ].join(' '),
    inputSchema: z.strictObject({
      ids: idsField(MAX_MOVE_IDS).describe('Message ids to move'),
      accountId: uuidField('accountId').describe('The account the messages and the folder belong to (account_id from list_accounts)'),
      folder: z.string().min(1).max(255).describe('Destination folder path, exactly as list_folders shows it'),
      includeNonInbox: INCLUDE_NON_INBOX,
    }),
    annotations: RELOCATE,
  }, async ({ ids: requestedIds, accountId, folder, includeNonInbox }, client) => {
    const ids = uniqueIds(requestedIds);
    const account = requireEnabledAccount(await loadAccounts(client), accountId);
    const folders = await client.listFolders(account.id);
    const list = Array.isArray(folders) ? folders : [];
    const destination = list.find(entry => entry.path === folder);
    if (!destination) {
      throw new ToolError(`${accountLabel(account)} has no folder ${JSON.stringify(folder)}; nothing was moved. list_folders shows the exact paths.`);
    }
    if (destination.no_select) throw new ToolError(`${pathLabel(folder)} is a container that holds no mail; nothing was moved.`);

    const loaded = await loadRows(client, ids);
    const skipped = [];
    const act = [];
    for (const entry of loaded) {
      if (entry.missing) { skipped.push({ id: entry.id, reason: NOT_FOUND_REASON }); continue; }
      if (entry.error) { skipped.push({ id: entry.id, reason: `could not load it: ${entry.error.message}` }); continue; }
      const row = entry.row;
      if (lower(row.account_id) !== lower(account.id)) {
        skipped.push({ id: entry.id, reason: `it belongs to another account (account_id=${row.account_id}); MailFlow moves mail only within its own account` });
        continue;
      }
      const reason = skipReason(entry, list, includeNonInbox);
      if (reason) { skipped.push({ id: entry.id, reason }); continue; }
      if (row.folder === folder) { skipped.push({ id: entry.id, reason: `already in ${pathLabel(folder)}` }); continue; }
      act.push(row);
    }
    if (!act.length) return textResult(relocationReport({ verb: 'Moved', requested: ids.length, acted: [], skipped, failed: [], destination: () => '' }), { isError: true });

    let result;
    try {
      result = await client.bulkMove(act.map(row => row.id), folder);
    } catch (err) {
      const text = relocationReport({ verb: 'Moved', requested: ids.length, acted: [], skipped, failed: [], destination: () => '' });
      const note = err instanceof MailflowError && err.mayHaveCompleted ? ' Check with search_mail or read_message by Message-ID before trying again.' : '';
      return textResult(`${text}\nThe move request failed: ${err.message}${note}`, { isError: true });
    }
    const moved = new Set((Array.isArray(result?.moved) ? result.moved : []).map(lower));
    const done = act.filter(row => moved.has(lower(row.id)));
    const failed = act.filter(row => !moved.has(lower(row.id))).map(row => ({
      id: row.id,
      reason: 'MailFlow did not move it (it may have been moved meanwhile, or the mail server refused the move)',
    }));
    const text = relocationReport({ verb: 'Moved', requested: ids.length, acted: done, skipped, failed, destination: () => pathLabel(folder) });
    return textResult(text, { isError: done.length === 0 });
  });

  registerTool(server, context, 'snooze', {
    title: 'Snooze',
    description: 'Snooze a message until a time up to 30 days ahead: MailFlow moves it, and the rest of its reply chain in the same folder, to the Snoozed folder, and brings them all back to that folder unread at that time. The id stays the same. On a message that is already snoozed this changes when it comes back.',
    inputSchema: z.strictObject({
      id: uuidField('id').describe('Message id'),
      until: z.iso.datetime({ offset: true, error: 'until must be an ISO 8601 date and time with a Z or an offset, such as 2026-10-20T09:00:00+02:00' })
        .describe('When it comes back, with Z or an offset, e.g. 2026-10-20T09:00:00+02:00'),
    }),
    annotations: ONE_WAY,
  }, async ({ id, until }, client) => {
    const when = new Date(until);
    const now = Date.now();
    if (Number.isNaN(when.getTime()) || when.getTime() <= now) throw new ToolError('until must be in the future');
    if (when.getTime() > now + MAX_SNOOZE_DAYS * 86400000) throw new ToolError(`MailFlow snoozes for at most ${MAX_SNOOZE_DAYS} days`);
    const row = await client.getMessage(id.toLowerCase());
    if (row.folder === SNOOZED_FOLDER) {
      const result = await client.rescheduleSnooze(row.id, when.toISOString());
      return textResult(`id=${row.id} was already snoozed; it and the messages snoozed with it now come back at ${formatDate(result?.until || when)}.`);
    }
    await client.snooze(row.id, when.toISOString());
    return textResult(`Snoozed id=${row.id} (account_id=${row.account_id}) and the rest of its reply chain in ${pathLabel(row.folder)} until ${formatDate(when)}. They wait in the Snoozed folder and come back to ${pathLabel(row.folder)} unread then. The id stays the same; unsnooze brings them back now.`);
  });

  registerTool(server, context, 'unsnooze', {
    title: 'Unsnooze',
    description: 'Bring a snoozed message, and everything snoozed with it, back now to the folder it was snoozed from, keeping its read state.',
    inputSchema: z.strictObject({
      id: uuidField('id').describe('Id of the snoozed message (list_messages with folder "Snoozed" shows them)'),
    }),
    annotations: ONE_WAY,
  }, async ({ id }, client) => {
    let result;
    try {
      result = await client.unsnooze(id.toLowerCase());
    } catch (err) {
      if (!(err instanceof MailflowError) || err.code !== 'not_snoozed') throw err;
      // The message is there, so say where it is rather than only that it is not snoozed.
      const row = await client.getMessage(id.toLowerCase()).catch(() => null);
      if (!row) throw err;
      throw new ToolError(`id=${row.id} is not snoozed: it is in ${pathLabel(row.folder)} (account_id=${row.account_id}). list_messages with folder "Snoozed" shows snoozed mail.`);
    }
    const restored = Number(result?.restored ?? 0);
    return textResult(`Brought back ${restored} message${restored === 1 ? '' : 's'} snoozed with id=${id.toLowerCase()} to where they were snoozed from; read state kept.`);
  });

  registerTool(server, context, 'set_category', {
    title: 'Set category',
    description: "Set a message's MailFlow category (primary, newsletter, promotion, automated or social). Only MailFlow keeps categories; the mail server is not changed.",
    inputSchema: z.strictObject({
      id: uuidField('id').describe('Message id'),
      category: z.enum(CATEGORIES),
    }),
    annotations: CHANGE,
  }, async ({ id, category }, client) => {
    const result = await client.setCategory(id.toLowerCase(), category);
    return textResult(`Category of id=${id.toLowerCase()} set to ${result?.category || category}.`);
  });
}
