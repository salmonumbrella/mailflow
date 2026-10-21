import { z } from 'zod';
import { registerTool, textResult, uuidField, messageIdField, normalizeMessageId } from './shared.js';
import { loadAccounts, requireEnabledAccount } from '../accounts.js';
import { buildReply, parseRecipients, applyAutoRecipients, unexpectedBcc, formatRecipients, replyRecipientChecks } from '../replies.js';
import { untrustedBlock, bodyText, displayAddress, displayAddressList, accountLabel, oneLine } from '../format.js';
import { pathLabel } from '../folders.js';
import { MailflowError } from '../mailflowClient.js';
import { ToolError } from '../errors.js';

const MAX_RECIPIENTS = 50;
const QUOTE_SOURCE_CHARS = 30000;

const recipients = what => z.array(z.string().min(3).max(400)).max(MAX_RECIPIENTS)
  .describe(`${what}: each entry one address, "email" or "Name <email>"`);

const DESCRIPTION = [
  'Save a draft in an account\'s Drafts folder for the user to review and send in MailFlow; nothing is sent.',
  'For a new message give accountId, to, subject and body. For a reply give replyToId (a message id) or replyToMessageId with accountId:',
  'the recipients (Reply-To if the original has one, else the sender; with replyAll also its other recipients minus the user\'s own addresses),',
  'subject (Re: …), threading headers, the send-as alias the original was addressed to, and a quote of the original are filled in.',
  'Explicit to, cc or subject replace the computed ones. The account\'s automatic Cc and Bcc are added as the web composer adds them.',
  'Before replying to an INBOX message it checks that no reply draft exists yet and refuses when one does, or when that cannot be checked, unless allowDuplicateReply is true.',
  'The body is plain text.',
].join(' ');

function describeVerdict(verdict) {
  if (verdict.exists) return 'A reply draft to this conversation already exists in Drafts.';
  return `Could not confirm that no reply draft exists yet (${verdict.unknown}).`;
}

// MailFlow's reply-draft indicator, read as exists / missing / unknown. Anything other than a
// clear "no draft" is unknown, and unknown is not treated as "none".
async function replyDraftVerdict(client, original) {
  try {
    const result = await client.replyDraftIndicators([original.id], original.account_id);
    const entry = result?.indicators?.[original.id];
    if (!entry) return { unknown: 'MailFlow did not report on this message' };
    if (entry.unknown) return { unknown: 'the conversation is too large for MailFlow to check' };
    if (entry.exists === true) return { exists: true };
    if (entry.exists === false) return { exists: false };
    return { unknown: 'MailFlow answered in a form this server does not know' };
  } catch (err) {
    return { unknown: err.message };
  }
}

export function registerDraftTools(server, context) {
  registerTool(server, context, 'create_draft', {
    title: 'Create a draft',
    description: DESCRIPTION,
    inputSchema: z.strictObject({
      accountId: uuidField('accountId').optional().describe('Account to save the draft in (account_id from list_accounts). Needed for a new message and with replyToMessageId; a reply by replyToId uses the original\'s account.'),
      aliasId: uuidField('aliasId').optional().describe('Send-as alias of that account (alias_id from list_accounts). For a reply the alias the original was addressed to is chosen when this is left out.'),
      to: recipients('To').optional(),
      cc: recipients('Cc').optional(),
      bcc: recipients('Bcc').optional(),
      subject: z.string().max(998).optional().describe('Subject; for a reply it defaults to Re: and the original subject'),
      body: z.string().max(100000).describe('The message text, plain text'),
      replyToId: uuidField('replyToId').optional().describe('MailFlow id of the message to reply to'),
      replyToMessageId: messageIdField.optional().describe('RFC Message-ID of the message to reply to, with accountId'),
      replyAll: z.boolean().optional().describe('Reply to all: Cc the original\'s other recipients'),
      includeQuote: z.boolean().default(true).describe('Quote the original below the reply'),
      allowDuplicateReply: z.boolean().default(false).describe('Save even when a reply draft already exists, or when that cannot be checked'),
    }).refine(value => !(value.replyToId && value.replyToMessageId), { error: 'Give replyToId or replyToMessageId, not both', path: ['replyToId'] }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input, client) => {
    const isReply = Boolean(input.replyToId || input.replyToMessageId);
    if (input.replyAll && !isReply) throw new ToolError('replyAll applies only to replies: give replyToId or replyToMessageId');
    if (!isReply && !input.accountId) throw new ToolError('accountId is required for a new message (list_accounts shows them)');
    if (input.replyToMessageId && !input.accountId) throw new ToolError('accountId is required with replyToMessageId, so the reply is drafted in the right account');
    // Parsed before anything is sent, so a malformed address fails without a request.
    const explicit = {
      to: input.to ? parseRecipients(input.to, 'to') : undefined,
      cc: input.cc ? parseRecipients(input.cc, 'cc') : undefined,
      bcc: input.bcc ? parseRecipients(input.bcc, 'bcc') : undefined,
    };

    const accounts = await loadAccounts(client);
    let original = null;
    if (input.replyToId) original = await client.getMessage(input.replyToId.toLowerCase());
    else if (input.replyToMessageId) original = await client.resolveMessage(normalizeMessageId(input.replyToMessageId), input.accountId.toLowerCase());
    const accountId = (original ? original.account_id : input.accountId).toLowerCase();
    if (original && input.accountId && input.accountId.toLowerCase() !== String(original.account_id).toLowerCase()) {
      throw new ToolError(`The original message belongs to account_id=${original.account_id}; a reply is drafted in the same account, so accountId ${input.accountId} was refused.`);
    }
    const account = requireEnabledAccount(accounts, accountId);
    let alias = null;
    if (input.aliasId) {
      alias = (account.aliases || []).find(entry => String(entry.id).toLowerCase() === input.aliasId.toLowerCase());
      if (!alias) throw new ToolError(`aliasId ${input.aliasId} is not an alias of ${accountLabel(account)} (list_accounts shows its aliases)`);
    }

    let reply = null;
    let verdict = null;
    if (original) {
      // MailFlow tracks reply drafts for INBOX messages only.
      if (original.folder === 'INBOX') {
        verdict = await replyDraftVerdict(client, original);
        if ((verdict.exists || verdict.unknown) && !input.allowDuplicateReply) {
          const advice = verdict.exists
            ? 'Edit that draft in MailFlow, or call create_draft again with allowDuplicateReply: true to save another one.'
            : 'Check Drafts in MailFlow, then call create_draft again with allowDuplicateReply: true to save it anyway.';
          return textResult(`No draft was saved. ${describeVerdict(verdict)} ${advice}`, { isError: true });
        }
      }
      let quoteText = null;
      if (input.includeQuote) {
        let body;
        try {
          body = await client.getMessageBody(original.id);
        } catch (err) {
          throw new ToolError(`No draft was saved: the original's text for the quote did not load (${err.message}). Try again, or set includeQuote: false.`);
        }
        quoteText = bodyText(body, QUOTE_SOURCE_CHARS).text || null;
      }
      reply = buildReply({
        original,
        account,
        replyAll: Boolean(input.replyAll),
        quoteText,
        includeQuote: input.includeQuote,
        overrides: { to: explicit.to, cc: explicit.cc, subject: input.subject },
      });
      if (!reply.to.length && !explicit.to) {
        throw new ToolError('The original has no usable sender or Reply-To address, so there is no one to reply to; give to explicitly.');
      }
      if (!alias && reply.alias) alias = reply.alias;
    }

    const base = {
      to: reply ? reply.to : explicit.to || [],
      cc: reply ? reply.cc : explicit.cc || [],
      bcc: explicit.bcc || [],
    };
    const withAuto = applyAutoRecipients(base, account);
    const subject = reply ? reply.subject : String(input.subject ?? '').replace(/[\r\n\0]+/g, ' ').trim();
    const payload = {
      accountId: account.id,
      ...(alias ? { aliasId: alias.id } : {}),
      to: formatRecipients(withAuto.to),
      cc: formatRecipients(withAuto.cc),
      bcc: formatRecipients(withAuto.bcc),
      subject,
      body: input.body,
      bodyIsHtml: false,
      includeIdentity: true,
      ...(reply?.inReplyTo ? { inReplyTo: reply.inReplyTo } : {}),
      ...(reply?.references ? { references: reply.references } : {}),
      ...(reply?.quotedBody ? { quotedBody: reply.quotedBody } : {}),
      // MailFlow appends the default signature unless told otherwise; the web composer leaves it
      // off when the account has it turned off by default.
      ...(account.signature_enabled === false ? { editedSignature: '' } : {}),
    };

    let saved;
    try {
      saved = await client.saveDraft(payload);
    } catch (err) {
      if (err instanceof MailflowError && err.mayHaveCompleted) {
        throw new MailflowError(`${err.message} The draft may have been saved anyway: look in Drafts in MailFlow before trying again (for a reply, create_draft also checks for an existing reply draft).`, err);
      }
      throw err;
    }

    const lines = [
      `Draft saved to ${pathLabel(saved?.folder || 'Drafts')} in ${accountLabel(account)}. Review and send it from MailFlow.`,
      `uid=${saved?.uid ?? 'unknown (the mail server did not say)'} folder=${pathLabel(saved?.folder || 'Drafts')} messageId=${oneLine(saved?.messageId || 'not returned', 300)} account_id=${account.id}${alias ? ` alias_id=${alias.id}` : ''}`,
    ];
    if (original) {
      let check = '';
      if (verdict?.exists === false) check = '; no earlier reply draft was found';
      else if (verdict?.exists) check = '; saved although a reply draft already existed (allowDuplicateReply)';
      else if (verdict?.unknown) check = '; saved without confirming that no reply draft existed (allowDuplicateReply)';
      const threading = payload.inReplyTo ? ', with In-Reply-To and References set' : ' (the original has no usable Message-ID, so it is not threaded)';
      lines.push(`It replies to id=${original.id}${threading}${check}.`);
      if (input.includeQuote && !payload.quotedBody) lines.push('The original had no text to quote.');
    }
    // Looked at in the recipients the draft has, whether computed or given: an address given
    // explicitly may have come from an email asking for it.
    const checks = original ? replyRecipientChecks({ original, account, to: withAuto.to, cc: withAuto.cc }) : null;
    const warnings = [];
    if (checks?.replyTo.length) warnings.push('the reply goes to the original\'s Reply-To address, which is not its sender (both are shown below)');
    if (checks?.own.length) warnings.push('the reply goes to one of the user\'s own addresses');
    if (checks?.notOnOriginal.length) {
      const count = checks.notOnOriginal.length;
      warnings.push(`${count} recipient${count === 1 ? ' was' : 's were'} not on the original message at all (listed below)`);
    }
    const extraBcc = unexpectedBcc(withAuto.bcc, account);
    if (extraBcc.length) warnings.push(`Bcc has ${extraBcc.length} address${extraBcc.length === 1 ? '' : 'es'} that ${extraBcc.length === 1 ? 'is' : 'are'} not this account's automatic Bcc`);
    if (reply?.skipped?.length) warnings.push(`${reply.skipped.length} of the original's recipients had addresses MailFlow could not use and were left out`);
    for (const warning of warnings) lines.push(`Check before sending: ${warning}.`);
    if (withAuto.added.cc.length || withAuto.added.bcc.length) {
      lines.push(`Added the account's automatic recipients: ${[withAuto.added.cc.length ? `Cc ${withAuto.added.cc.join(', ')}` : null, withAuto.added.bcc.length ? `Bcc ${withAuto.added.bcc.join(', ')}` : null].filter(Boolean).join('; ')}.`);
    }
    lines.push(account.signature_enabled === false ? 'No signature (the account has it off by default).' : 'MailFlow added the default signature.');

    const recipientsBlock = [
      `To: ${displayAddressList(withAuto.to, 50) || '(none)'}`,
      `Cc: ${displayAddressList(withAuto.cc, 50) || '(none)'}`,
      `Bcc: ${displayAddressList(withAuto.bcc, 50) || '(none)'}`,
      `Subject: ${oneLine(subject, 500) || '(no subject)'}`,
    ];
    if (original) {
      recipientsBlock.push(`Original sender: ${displayAddress({ name: original.from_name, email: original.from_email }) || '(unknown)'}`);
      if (Array.isArray(original.reply_to) && original.reply_to.length) recipientsBlock.push(`Original Reply-To: ${displayAddressList(original.reply_to, 5)}`);
      if (reply?.skipped?.length) recipientsBlock.push(`Left out (unusable addresses): ${reply.skipped.map(value => oneLine(value, 100)).join(', ')}`);
      if (checks?.notOnOriginal.length) recipientsBlock.push(`Not on the original: ${displayAddressList(checks.notOnOriginal, 50)}`);
    }
    if (extraBcc.length) recipientsBlock.push(`Bcc not added automatically: ${extraBcc.map(entry => displayAddress(entry)).join(', ')}`);
    lines.push('', untrustedBlock(recipientsBlock.join('\n')));
    return textResult(lines.join('\n'));
  });
}
