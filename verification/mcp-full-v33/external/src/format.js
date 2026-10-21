import { randomBytes } from 'node:crypto';
import { htmlToText } from './html.js';

export { htmlToText };

const MARKER_NAME = 'untrusted-email-content';

// Each block's markers carry an id made for that one result. Email text cannot know it, so
// nothing in an email can end the block early or open another, and the instructions tell the
// model that only the marker with the block's id ends it.
export function newBlockId() {
  return randomBytes(9).toString('base64url');
}

export const markerOpen = id => `<${MARKER_NAME} id="${id}">`;
export const markerClose = id => `</${MARKER_NAME} id="${id}">`;

// Control characters other than tab and the line breaks, C1 included.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
// Characters that do not show, or only change how a neighbour shows: format characters (zero
// width, bidi controls, tags), the combining grapheme joiner, Hangul fillers, Khmer inherent
// vowels and the variation selectors.
const IGNORABLE = /[\p{Cf}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u3164\ufe00-\ufe0f\uffa0\u{e0100}-\u{e01ef}]/gu;

// Letters of other scripts that look like the Latin letters of the marker's name, and brackets
// that look like < and >. Text is compared after compatibility decomposition, without accents and
// in lower case, so fullwidth, styled and accented letters need no entry here.
const LOOKALIKE = new Map([
  // Cyrillic
  ['\u0430', 'a'], ['\u0441', 'c'], ['\u0501', 'd'], ['\u0435', 'e'], ['\u04bd', 'e'], ['\u0456', 'i'],
  ['\u04cf', 'l'], ['\u043c', 'm'], ['\u043e', 'o'], ['\u0433', 'r'], ['\u0455', 's'], ['\u0442', 't'],
  // Greek
  ['\u03b1', 'a'], ['\u03f2', 'c'], ['\u03b5', 'e'], ['\u03b9', 'i'], ['\u03b7', 'n'], ['\u03bf', 'o'],
  ['\u03c3', 'o'], ['\u03c4', 't'], ['\u03c5', 'u'], ['\u03bc', 'u'],
  // Armenian
  ['\u0578', 'n'], ['\u0585', 'o'], ['\u057d', 'u'],
  // Latin extensions and small capitals
  ['\u0251', 'a'], ['\u1d04', 'c'], ['\u0131', 'i'], ['\u0269', 'i'], ['\u01c0', 'l'], ['\u1d26', 'r'],
  ['\ua731', 's'], ['\u1d1c', 'u'],
  // Angle brackets
  ['\u2039', '<'], ['\u203a', '>'], ['\u3008', '<'], ['\u3009', '>'], ['\u27e8', '<'], ['\u27e9', '>'],
]);

// The marker's name as a model might read it: its words in any case, width or script, with
// spaces, dashes, dots or underscores between them; also l, 1 and | for i or l, rn for m and 0
// for o. Tag-shaped markers go whole, with their attributes. Matched in folded text (see fold).
// No separator is a letter and the attributes are bounded, so a hostile body cannot make the
// scan backtrack.
const GAP = '[\\s\\p{Pd}_.\\u00b7\\u2022\\u2027\\u2043\\u2212\\u2219\\u22c5\\u30fb]*';
const NAME = `untrusted${GAP}e(?:m|rn)a[il1|]{2}${GAP}c[o0]ntent`;
const MARKER = new RegExp(`<\\s*(?:/\\s*)?${NAME}[^<>]{0,200}>|${NAME}`, 'giu');

const FOLDED = new Map();

// One character as the marker is compared with it.
function foldChar(ch) {
  let value = FOLDED.get(ch);
  if (value === undefined) {
    value = '';
    for (const c of ch.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()) value += LOOKALIKE.get(c) ?? c;
    if (FOLDED.size < 20000) FOLDED.set(ch, value);
  }
  return value;
}

// The text folded for matching, and for each folded unit the span of `text` it came from, so a
// match in the folded text removes exactly that part of the original.
function fold(text) {
  let folded = '';
  const from = [];
  const to = [];
  for (let i = 0; i < text.length;) {
    const size = text.codePointAt(i) > 0xffff ? 2 : 1;
    const value = text.charCodeAt(i) < 0x80 ? text[i] : foldChar(text.slice(i, i + size));
    for (let k = 0; k < value.length; k++) {
      from.push(i);
      to.push(i + size);
    }
    folded += value;
    i += size;
  }
  return { folded, from, to };
}

export function neutralizeMarkers(text) {
  // Invisible and control characters go first: none can then sit inside a marker unnoticed, and
  // nothing taken out after the check can put a marker back together.
  const source = String(text ?? '').replace(CONTROL, '').replace(IGNORABLE, '');
  const ascii = !/[^\u0000-\u007f]/.test(source);
  const { folded, from, to } = ascii ? { folded: source } : fold(source);
  let out = '';
  let last = 0;
  for (const match of folded.matchAll(MARKER)) {
    const start = ascii ? match.index : from[match.index];
    const end = ascii ? match.index + match[0].length : to[match.index + match[0].length - 1];
    out += `${source.slice(last, Math.max(last, start))}[marker removed]`;
    last = Math.max(last, end);
  }
  return out ? out + source.slice(last) : source;
}

// One block per tool result holds every piece of text that came from an email.
export function untrustedBlock(body, id = newBlockId()) {
  return `${markerOpen(id)}\n${neutralizeMarkers(body).trimEnd()}\n${markerClose(id)}`;
}

// A single display line: no line breaks, control or invisible characters, at most `max` characters.
export function oneLine(value, max = 200) {
  const text = String(value ?? '').replace(IGNORABLE, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function truncate(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return { text: value, truncated: false, total: value.length };
  let cut = value.lastIndexOf('\n', max);
  if (cut < max * 0.8) cut = value.lastIndexOf(' ', max);
  if (cut < max * 0.8) cut = max;
  return { text: value.slice(0, cut).trimEnd(), truncated: true, total: value.length };
}

// The readable text of a body MailFlow returned: its text/plain part, else its HTML as text.
export function bodyText(body, maxChars) {
  if (typeof body?.text === 'string' && body.text.trim()) {
    const text = body.text.replace(/\r\n?/g, '\n').replace(IGNORABLE, '');
    return { text, source: 'text', complete: true };
  }
  if (typeof body?.html === 'string' && body.html.trim()) {
    const { text, complete } = htmlToText(body.html, { maxChars });
    return { text, source: 'html', complete };
  }
  return { text: '', source: 'none', complete: true };
}

export function formatDate(value) {
  if (value === null || value === undefined || value === '') return 'unknown date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown date';
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatCount(value) {
  return Number(value).toLocaleString('en-US');
}

// For display inside an untrusted block only; drafts get their addresses from replies.js.
export function displayAddress(entry) {
  if (!entry) return '';
  const email = oneLine(entry.email, 254);
  const name = oneLine(entry.name, 120);
  if (!email) return name;
  return name && name.toLowerCase() !== email.toLowerCase() ? `${name} <${email}>` : email;
}

export function displayAddressList(list, max = 25) {
  const entries = (Array.isArray(list) ? list : []).map(displayAddress).filter(Boolean);
  if (!entries.length) return '';
  const shown = entries.slice(0, max).join(', ');
  return entries.length > max ? `${shown} and ${entries.length - max} more` : shown;
}

export function accountLabel(account) {
  if (!account) return 'an unknown account';
  const name = oneLine(account.name || account.account_name, 80);
  const email = oneLine(account.email_address || account.account_email, 254);
  if (name && email && name.toLowerCase() !== email.toLowerCase()) return `${name} <${email}>`;
  return email || name || String(account.id);
}
