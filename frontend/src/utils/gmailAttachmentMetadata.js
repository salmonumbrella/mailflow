import { copyAttachmentSource, attachmentSourceMatchesRow } from './attachmentSource.js';

const PART = /^[1-9]\d*(?:\.[1-9]\d*)*$/;
const MIME = /^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+$/;
const CALENDAR_TYPES = new Set(['text/calendar', 'text/x-vcalendar', 'application/ics',
  'application/calendar', 'application/icalendar', 'application/x-icalendar', 'application/x-vcalendar']);
// These labels come from mail, so invisible controls must not disguise an extension.
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const boundedText = (value, limit) => typeof value === 'string' && value.length <= limit ? value : null;
const partNumber = value => boundedText(value, 128) && PART.test(value) ? value : null;

// List metadata is deliberately separate from body-reader attachments: only this
// verified physical message can supply its filenames. Nothing here fetches parts.
export function gmailAttachmentMetadata(message) {
  const metadata = message?.attachmentMetadata;
  const source = copyAttachmentSource(metadata?.source);
  if (!metadata || metadata.state !== 'partial' || metadata.scope !== 'message'
    || metadata.providerComplete !== false || metadata.inlineClassification !== 'partial'
    || !Array.isArray(metadata.items) || !source || !attachmentSourceMatchesRow(source, message)) return null;

  const entries = metadata.items.slice(0, 100);
  const counts = new Map();
  for (const entry of entries) {
    const part = partNumber(entry?.part);
    if (part) counts.set(part, (counts.get(part) || 0) + 1);
  }
  const items = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const part = partNumber(entry.part);
    const filename = boundedText(entry.filename, 512)?.replace(INVISIBLE, '').trim();
    if (!part || counts.get(part) !== 1 || !filename) continue;
    const type = boundedText(entry.type, 128)?.split(';', 1)[0].trim().toLowerCase();
    const disposition = boundedText(entry.disposition, 128)?.split(';', 1)[0].trim().toLowerCase();
    if ((entry.shownInline != null && entry.shownInline !== false) || (entry.inline != null && entry.inline !== false)
      || disposition === 'inline' || CALENDAR_TYPES.has(type) || /\.(?:ics|ical|icalendar|vcs)[.\s]*$/i.test(filename)) continue;
    items.push({ part, filename, type: type && MIME.test(type) ? type : null,
      size: Number.isSafeInteger(entry.size) && entry.size > 0 ? entry.size : null });
    if (items.length === 3) break;
  }
  if (!items.length) return null;
  // The server's omitted count includes inline, invalid and unscanned entries.
  // It cannot be advertised as a number of additional files.
  return { source, items, hasMore: metadata.items.length > items.length || metadata.omittedCount !== 0 };
}
