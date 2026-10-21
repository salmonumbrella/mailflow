// Builds reply drafts and recipient strings from MailFlow's structured message rows. Pure: no
// network, no clock. Every address handed to MailFlow is built here from { name, email } fields,
// never by gluing strings an email supplied, so a hostile display name cannot add a recipient.

// One address, no display name; close to MailFlow's own BARE_ADDRESS_RE, plus the characters
// that would end or escape a quoted name.
const EMAIL = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]+$/;
const MAX_EMAIL_LENGTH = 254;
// A name containing any of these must be quoted, or a parser reads it as structure: a group
// ("Team: a@x;"), a comment, a second address.
const NEEDS_QUOTES = /[",<>;:@()[\]\\]/;
const MESSAGE_ID = /^<[^<>\s]+>$/;
const MAX_HEADER_ID_LENGTH = 998;
// MailFlow refuses an In-Reply-To or References value over 8192 characters.
export const MAX_REFERENCES_LENGTH = 8192;
export const MAX_QUOTE_CHARS = 20000;

export class RecipientError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecipientError';
  }
}

const lower = value => String(value ?? '').trim().toLowerCase();

export function isEmail(value) {
  return typeof value === 'string' && value.length <= MAX_EMAIL_LENGTH && EMAIL.test(value);
}

// Line breaks would start a new header; a double quote or a backslash would end or escape the
// quoted string the name may be wrapped in (a trailing backslash swallows the closing quote).
export function cleanName(name) {
  return String(name ?? '')
    .replace(/[\r\n"\\]/g, ' ')
    .replace(/[\u0000-\u001f\u007f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export function formatAddress({ name, email } = {}) {
  const address = typeof email === 'string' ? email.trim() : '';
  if (!isEmail(address)) return null;
  const clean = cleanName(name);
  if (!clean || clean.toLowerCase() === address.toLowerCase()) return address;
  return `${NEEDS_QUOTES.test(clean) ? `"${clean}"` : clean} <${address}>`;
}

// A recipient typed by the user or the model: "email" or "Name <email>", one address only.
export function parseRecipient(value, field = 'recipient') {
  if (typeof value !== 'string') throw new RecipientError(`${field}: every recipient must be a string`);
  if (/[\r\n\0]/.test(value)) throw new RecipientError(`${field}: ${JSON.stringify(value)} contains a line break`);
  const text = value.trim();
  if (!text) throw new RecipientError(`${field}: an empty recipient was given`);
  const opens = (text.match(/</g) || []).length;
  const closes = (text.match(/>/g) || []).length;
  if (opens > 1 || closes > 1) {
    throw new RecipientError(`${field}: ${JSON.stringify(text)} has more than one <…>; give one recipient per entry, as "Name <email>" or "email"`);
  }
  let name = '';
  let email = text;
  if (opens || closes) {
    const match = /^([^<>]*)<([^<>]*)>$/.exec(text);
    if (!match) throw new RecipientError(`${field}: ${JSON.stringify(text)} must look like "Name <email>" or "email"`);
    name = match[1].trim().replace(/^"(.*)"$/, '$1');
    email = match[2].trim();
  }
  if (!isEmail(email)) {
    throw new RecipientError(`${field}: ${JSON.stringify(text)} is not one email address; put each recipient in its own entry`);
  }
  return { name, email };
}

export function parseRecipients(values, field) {
  return (values || []).map(value => parseRecipient(value, field));
}

export function headerIds(value) {
  return typeof value === 'string' ? (value.match(/<[^<>\s]+>/g) || []).filter(id => id.length <= MAX_HEADER_ID_LENGTH) : [];
}

export function isMessageIdToken(value) {
  return typeof value === 'string' && value.length <= MAX_HEADER_ID_LENGTH && MESSAGE_ID.test(value);
}

export function replySubject(subject) {
  const text = String(subject ?? '').replace(/[\r\n\0]+/g, ' ').trim();
  if (!text) return 'Re:';
  return /^re:/i.test(text) ? text : `Re: ${text}`;
}

// The original's References (or its In-Reply-To when it has none) followed by its own
// Message-ID, as RFC 5322 3.6.4 says, de-duplicated. When it is too long for MailFlow, the
// first id (the conversation's root) and the newest ones are kept.
export function buildReferences(original) {
  const inherited = headerIds(original?.thread_references);
  const base = inherited.length ? inherited : headerIds(original?.in_reply_to);
  const own = isMessageIdToken(original?.message_id) ? [original.message_id] : [];
  const ids = [...new Set([...base, ...own])];
  if (!ids.length) return null;
  const joined = ids.join(' ');
  if (joined.length <= MAX_REFERENCES_LENGTH) return joined;
  const kept = [];
  let length = ids[0].length;
  for (let i = ids.length - 1; i > 0; i--) {
    if (length + 1 + ids[i].length > MAX_REFERENCES_LENGTH) break;
    kept.unshift(ids[i]);
    length += 1 + ids[i].length;
  }
  return [ids[0], ...kept].join(' ');
}

export function replyInReplyTo(original) {
  return isMessageIdToken(original?.message_id) ? original.message_id : null;
}

function quoteDate(value) {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? date.toUTCString() : 'an unknown date';
}

export function quoteBody({ date, fromName, fromEmail, text, maxChars = MAX_QUOTE_CHARS }) {
  // trimEnd, not /\s+$/: on a long run of spaces inside the text that pattern takes quadratic time.
  const source = String(text ?? '').replace(/\r\n?/g, '\n').trimEnd();
  if (!source.trim()) return null;
  const who = formatAddress({ name: fromName, email: fromEmail }) || cleanName(fromName) || 'the sender';
  let quoted = source.split('\n').map(line => `> ${line}`).join('\n');
  if (quoted.length > maxChars) {
    const cut = quoted.lastIndexOf('\n', maxChars);
    quoted = `${quoted.slice(0, cut > 0 ? cut : maxChars)}\n> [quote shortened]`;
  }
  return `\n\n---\nOn ${quoteDate(date)}, ${who} wrote:\n${quoted}`;
}

export function ownAddresses(account) {
  return new Set([account?.email_address, ...(account?.aliases || []).map(alias => alias?.email)].map(lower).filter(Boolean));
}

// The alias the original was addressed to: its delivery address, else an alias in To or Cc,
// else an alias that sent it.
export function pickReplyAlias(original, account) {
  const aliases = (account?.aliases || []).filter(alias => alias?.id && isEmail(alias.email));
  const delivered = new Set((original?.delivery_addresses || []).map(lower));
  const byDelivery = aliases.find(alias => delivered.has(lower(alias.email)));
  if (byDelivery) return byDelivery;
  const recipients = new Set([...(original?.to_addresses || []), ...(original?.cc_addresses || [])].map(entry => lower(entry?.email)));
  const byRecipient = aliases.find(alias => recipients.has(lower(alias.email)));
  if (byRecipient) return byRecipient;
  return aliases.find(alias => lower(alias.email) === lower(original?.from_email)) || null;
}

function dedupe(list) {
  const seen = new Set();
  return list.filter(entry => {
    const key = lower(entry.email);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The reply's recipients, subject and headers, computed from the original as MailFlow stores it
 * (GET /api/mail/messages/:id or resolve-message rows, which carry reply_to and delivery_addresses).
 * Explicit to / cc / subject replace the computed values; replyRecipientChecks looks at the result.
 */
export function buildReply({ original, account, replyAll = false, quoteText = null, includeQuote = true, overrides = {} }) {
  const own = ownAddresses(account);
  const replyTo = (original?.reply_to || []).find(entry => isEmail(entry?.email?.trim?.()));
  const sender = { name: original?.from_name || '', email: String(original?.from_email || '').trim() };
  const target = replyTo ? { name: replyTo.name || '', email: replyTo.email.trim() } : sender;
  const targetUsable = isEmail(target.email);
  const skipped = [];

  let to = targetUsable ? [target] : [];
  let cc = [];
  if (replyAll) {
    const targetKey = lower(target.email);
    for (const entry of [...(original?.to_addresses || []), ...(original?.cc_addresses || [])]) {
      const email = String(entry?.email || '').trim();
      if (!email) continue;
      if (!isEmail(email)) {
        skipped.push(email);
        continue;
      }
      const key = lower(email);
      if (own.has(key) || key === targetKey) continue;
      cc.push({ name: entry.name || '', email });
    }
    cc = dedupe(cc);
  }
  if (overrides.to) to = overrides.to;
  if (overrides.cc) cc = overrides.cc;
  const subject = overrides.subject !== undefined ? String(overrides.subject).replace(/[\r\n\0]+/g, ' ').trim() : replySubject(original?.subject);

  return {
    to,
    cc,
    subject,
    inReplyTo: replyInReplyTo(original),
    references: buildReferences(original),
    quotedBody: includeQuote && quoteText
      ? quoteBody({ date: original?.date, fromName: original?.from_name, fromEmail: original?.from_email, text: quoteText })
      : null,
    alias: pickReplyAlias(original, account),
    targetUsable,
    skipped,
  };
}

function uniqueByEmail(list) {
  return [...new Map(list.map(entry => [lower(entry.email), entry])).values()];
}

/**
 * What a reply's final To and Cc deserve a second look for, however they were chosen: the
 * original's Reply-To where it is not the sender, the user's own addresses in To, and addresses
 * that were nowhere on the original, which is what a reply an email asked to be sent elsewhere
 * looks like. The account's automatic Cc is expected and not counted.
 */
export function replyRecipientChecks({ original, account, to, cc }) {
  const sender = lower(original?.from_email);
  const replyTo = (original?.reply_to || []).map(entry => lower(entry?.email)).filter(Boolean);
  const notSender = new Set(replyTo.filter(address => address !== sender));
  const onOriginal = new Set([
    sender,
    ...replyTo,
    ...[...(original?.to_addresses || []), ...(original?.cc_addresses || [])].map(entry => lower(entry?.email)),
  ].filter(Boolean));
  const automatic = new Set(autoList(account?.auto_cc_addresses).map(lower));
  const own = ownAddresses(account);
  const recipients = uniqueByEmail([...to, ...cc]);
  return {
    replyTo: recipients.filter(entry => notSender.has(lower(entry.email))),
    own: uniqueByEmail(to).filter(entry => own.has(lower(entry.email))),
    notOnOriginal: recipients.filter(entry => !onOriginal.has(lower(entry.email)) && !automatic.has(lower(entry.email))),
  };
}

function autoList(value) {
  return (Array.isArray(value) ? value : []).filter(address => typeof address === 'string').map(address => address.trim()).filter(isEmail);
}

// The account's automatic Cc and Bcc, as the web composer adds them: each one not already among
// the recipients, and an address on both lists goes to Cc only.
export function applyAutoRecipients({ to, cc, bcc }, account) {
  const seen = new Set([...to, ...cc, ...bcc].map(entry => lower(entry.email)));
  const nextCc = [...cc];
  const nextBcc = [...bcc];
  const added = { cc: [], bcc: [] };
  for (const [list, target, record] of [[autoList(account?.auto_cc_addresses), nextCc, added.cc], [autoList(account?.auto_bcc_addresses), nextBcc, added.bcc]]) {
    for (const address of list) {
      const key = lower(address);
      if (seen.has(key)) continue;
      seen.add(key);
      target.push({ name: '', email: address });
      record.push(address);
    }
  }
  return { to, cc: nextCc, bcc: nextBcc, added };
}

// Bcc recipients the account does not add by itself: hidden recipients deserve a second look.
export function unexpectedBcc(bcc, account) {
  const automatic = new Set(autoList(account?.auto_bcc_addresses).map(lower));
  return bcc.filter(entry => !automatic.has(lower(entry.email)));
}

export function formatRecipients(list) {
  return list.map(entry => {
    const formatted = formatAddress(entry);
    if (!formatted) throw new RecipientError(`${JSON.stringify(String(entry?.email ?? ''))} is not a usable email address`);
    return formatted;
  });
}
