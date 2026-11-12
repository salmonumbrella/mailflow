import { createHash } from 'crypto';
import { parseRawHeaders, parseMailboxList } from './messageParser.js';

export const MAX_INVITATION_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_CALENDAR_BYTES = 256 * 1024;
const RESPONSES = new Set(['ACCEPTED', 'TENTATIVE', 'DECLINED']);
// Deliberately narrower than all RFC 5322 mailboxes. Ambiguous identities must not send a reply.
const EMAIL = /^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class InvitationError extends Error {
  constructor(status, message, code = 'invalid_invitation') {
    super(message);
    this.name = 'InvitationError';
    this.status = status;
    this.code = code;
  }
}
const invalid = message => { throw new InvitationError(422, message); };

function splitQuoted(value, delimiter) {
  const pieces = [];
  let start = 0, quoted = false;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '"') quoted = !quoted;
    else if (value[i] === delimiter && !quoted) { pieces.push(value.slice(start, i)); start = i + 1; }
  }
  if (quoted) invalid('The invitation contains an unfinished quoted parameter.');
  pieces.push(value.slice(start));
  return pieces;
}

function parameters(parts) {
  const params = {};
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) invalid('The invitation contains a malformed parameter.');
    const key = part.slice(0, eq).trim().toUpperCase();
    if (!/^[A-Z0-9-]+$/.test(key) || Object.hasOwn(params, key)) invalid('The invitation contains duplicate or invalid parameters.');
    params[key] = part.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return params;
}

function contentLine(raw) {
  let colon = -1, quoted = false;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '"') quoted = !quoted;
    else if (raw[i] === ':' && !quoted) { colon = i; break; }
  }
  if (colon < 1) invalid('The invitation contains an invalid calendar line.');
  const [name, ...parts] = splitQuoted(raw.slice(0, colon), ';');
  if (!/^[A-Z0-9-]+$/i.test(name)) invalid('The invitation contains an invalid property.');
  return { name: name.toUpperCase(), params: parameters(parts), value: raw.slice(colon + 1), raw };
}

function mimeType(value) {
  const [type, ...parts] = splitQuoted(value || 'text/plain', ';');
  return { type: type.trim().toLowerCase(), params: parameters(parts.filter(p => p.trim())) };
}

function decodeCalendar(body, headers, type) {
  const encoding = (headers['content-transfer-encoding'] || '7bit').toLowerCase();
  let bytes;
  if (encoding === 'base64') {
    const value = body.replace(/\s/g, '');
    if (!/^[a-z0-9+/]*={0,2}$/i.test(value) || value.length % 4 !== 0) invalid('The calendar attachment has invalid base64 encoding.');
    bytes = Buffer.from(value, 'base64');
  } else if (encoding === 'quoted-printable') {
    const value = body.replace(/=\r?\n/g, '');
    if (/=(?![0-9a-f]{2})/i.test(value)) invalid('The calendar attachment has invalid quoted-printable encoding.');
    bytes = Buffer.from(value.replace(/=([0-9a-f]{2})/gi, (_, code) => String.fromCharCode(parseInt(code, 16))), 'latin1');
  } else if (['7bit', '8bit', 'binary'].includes(encoding)) bytes = Buffer.from(body, 'latin1');
  else invalid('The calendar attachment uses an unsupported encoding.');
  if (bytes.length > MAX_CALENDAR_BYTES) invalid('This calendar attachment is too large to respond to here.');
  try { return new TextDecoder(type.params.CHARSET || 'utf-8', { fatal: true }).decode(bytes); }
  catch (cause) { throw new InvitationError(422, 'The calendar attachment cannot be decoded.', cause?.code || 'invalid_encoding'); }
}

// A bounded, strict MIME reader for calendar parts only. Attached messages are never traversed.
export function calendarFromSource(source) {
  if (!Buffer.isBuffer(source)) invalid('The original invitation could not be read. Reload the message.');
  if (source.length > MAX_INVITATION_SOURCE_BYTES) invalid('This invitation is too large to respond to here.');
  const calendars = [];
  let rootHeaders, parts = 0;
  function visit(raw, depth) {
    if (++parts > 100 || depth > 8) invalid('This invitation has too many MIME parts.');
    const separator = /\r?\n\r?\n/.exec(raw);
    if (!separator || separator.index > 65536) invalid('The invitation has invalid MIME headers.');
    const headers = parseRawHeaders(Buffer.from(raw.slice(0, separator.index), 'latin1'));
    if (!depth) rootHeaders = headers;
    for (const name of ['content-type', 'content-transfer-encoding', 'message-id', 'from', 'sender']) {
      if (headers[name]?.includes('\n')) invalid('The invitation has ambiguous headers.');
    }
    const body = raw.slice(separator.index + separator[0].length);
    const type = mimeType(headers['content-type']);
    if (type.type.startsWith('multipart/')) {
      const boundary = type.params.BOUNDARY;
      if (!boundary || boundary.length > 70 || /[\r\n]/.test(boundary)) invalid('The invitation has an invalid MIME boundary.');
      let current = null, closed = false;
      for (const line of body.split(/\r?\n/)) {
        if (line.trimEnd() === `--${boundary}` || line.trimEnd() === `--${boundary}--`) {
          if (current) visit(current.join('\r\n'), depth + 1);
          if (line.trimEnd() === `--${boundary}--`) { closed = true; break; }
          current = [];
        } else if (current) current.push(line);
      }
      if (!closed) invalid('The invitation MIME body is incomplete.');
    } else if (['text/calendar', 'application/ics', 'application/icalendar'].includes(type.type)) {
      calendars.push({ text: decodeCalendar(body, headers, type), method: type.params.METHOD?.toUpperCase() });
    }
  }
  visit(source.toString('latin1'), 0);
  if (calendars.length !== 1) invalid(calendars.length ? 'This message contains multiple calendars. Respond in your calendar app.' : 'This message does not contain a direct calendar invitation. Forwarded invitations are not supported.');
  return { ...calendars[0], headers: rootHeaders };
}

function mailto(prop) {
  if (!prop || !/^mailto:/i.test(prop.value)) invalid('The invitation does not have a supported email identity.');
  const email = prop.value.slice(7).toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) invalid('The invitation has an invalid email identity.');
  if (prop.params['SENT-BY']) invalid('Delegated invitations must be answered in your calendar app.');
  return email;
}
const textValue = value => (value || '').replace(/\\([nN\\;,])/g, (_, c) => /[nN]/.test(c) ? '\n' : c);

function checkDate(prop) {
  if (!prop) return;
  const isDate = prop.params.VALUE === 'DATE';
  if (Object.keys(prop.params).some(key => !['VALUE', 'TZID', 'RANGE'].includes(key))) invalid('The invitation has unsupported date parameters.');
  if (prop.params.VALUE && !['DATE', 'DATE-TIME'].includes(prop.params.VALUE)) invalid('The invitation has an unsupported date type.');
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(prop.value);
  if (!match || isDate === Boolean(match[4])) invalid('The invitation contains an invalid event date.');
  const [, y, mo, d, h = '00', m = '00', s = '00'] = match;
  const date = new Date(`${y}-${mo}-${d}T${h}:${m}:${s}Z`);
  if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== `${y}-${mo}-${d}`) invalid('The invitation contains an invalid event date.');
  if (prop.params.TZID && (isDate || match[7] || prop.params.TZID.length > 255)) invalid('The invitation has an ambiguous time zone.');
  if (prop.params.RANGE && prop.name !== 'RECURRENCE-ID') invalid('The invitation has a recurrence range on the wrong date property.');
  if (prop.params.RANGE && prop.params.RANGE !== 'THISANDFUTURE') invalid('The invitation has an unsupported recurrence range.');
}

export function parseCalendarInvitation(ics, { accountEmail, fromEmail, recipients, senderEmail, forwarded = false, mimeMethod, includeCancellation = false } = {}) {
  if (typeof ics !== 'string' || Buffer.byteLength(ics) > MAX_CALENDAR_BYTES || /\0/.test(ics)) invalid('The calendar attachment is invalid or too large.');
  const unfolded = ics.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter(Boolean);
  if (unfolded.length > 5000 || unfolded.some(line => line.length > 8192 || /[\r\n]/.test(line))) invalid('The calendar attachment has invalid or oversized lines.');
  const stack = [], events = [], calendar = {}, zones = [];
  let event, zone, roots = 0;
  for (const raw of unfolded) {
    const prop = contentLine(raw);
    if (prop.name === 'BEGIN') {
      const parent = stack.at(-1);
      const allowed = { VCALENDAR: ['VEVENT', 'VTIMEZONE'], VEVENT: ['VALARM'], VTIMEZONE: ['STANDARD', 'DAYLIGHT'] };
      if ((!stack.length && (prop.value !== 'VCALENDAR' || ++roots > 1)) || (parent && !allowed[parent]?.includes(prop.value))) invalid('The calendar structure is not supported.');
      stack.push(prop.value);
      if (prop.value === 'VEVENT') { event = {}; events.push(event); }
      if (prop.value === 'VTIMEZONE') { zone = []; zones.push(zone); }
      if (zone) zone.push(raw);
      continue;
    }
    if (prop.name === 'END') {
      if (stack.pop() !== prop.value) invalid('The calendar structure is incomplete.');
      if (zone) zone.push(raw);
      if (prop.value === 'VTIMEZONE') zone = null;
      continue;
    }
    if (zone) {
      if (['TZID', 'DTSTART', 'TZOFFSETFROM', 'TZOFFSETTO', 'TZNAME', 'RRULE', 'RDATE'].includes(prop.name)) zone.push(raw);
      continue;
    }
    const target = stack.at(-1) === 'VEVENT' ? event : stack.at(-1) === 'VCALENDAR' ? calendar : null;
    if (!target) {
      if (!stack.length) invalid('The calendar contains properties outside its event.');
      continue;
    }
    if (prop.name === 'ATTENDEE' && target === event) (event.ATTENDEE ||= []).push(prop);
    else {
      if (target[prop.name]) invalid('The calendar has duplicate properties.');
      target[prop.name] = prop;
    }
  }
  if (stack.length || events.length !== 1 || calendar.VERSION?.value !== '2.0') invalid('Only a single complete calendar event can be answered here.');
  const method = calendar.METHOD?.value;
  const cancelled = method === 'CANCEL' || event.STATUS?.value === 'CANCELLED';
  if (!['REQUEST', 'CANCEL'].includes(method) || (mimeMethod && mimeMethod !== method) || (cancelled && !includeCancellation)) invalid('Only active meeting requests can be answered. This may be a cancellation or a meeting response.');
  if (!event.UID?.value || event.UID.value.length > 1024 || !event.DTSTAMP || (!cancelled && !event.DTSTART)) invalid('The invitation is missing its event identity or date.');
  if (Object.keys(event.UID.params).length) invalid('The invitation has an unsupported event identity.');
  const sequence = event.SEQUENCE?.value || '0';
  if (!/^\d{1,9}$/.test(sequence)) invalid('The invitation has an invalid revision number.');
  for (const name of ['DTSTAMP', 'DTSTART', 'DTEND', 'RECURRENCE-ID']) checkDate(event[name]);
  if (!event.DTSTAMP.value.endsWith('Z')) invalid('The invitation has an invalid timestamp.');
  const organizer = mailto(event.ORGANIZER);
  const attendeeEmail = String(accountEmail || '').trim().toLowerCase();
  const attendees = event.ATTENDEE || [];
  if (attendees.length > 500) invalid('The invitation has too many attendees.');
  const matching = attendees.filter(attendee => /^mailto:/i.test(attendee.value) && attendee.value.slice(7).toLowerCase() === attendeeEmail);
  if (!EMAIL.test(attendeeEmail) || matching.length !== 1) invalid('RSVP is available only when this account’s own email address is an attendee. Unverified aliases and forwarded invitations must be answered in your calendar app.');
  const attendee = matching[0];
  mailto(attendee);
  if (attendee.params['DELEGATED-TO'] || attendee.params['DELEGATED-FROM'] || attendee.params.ROLE === 'NON-PARTICIPANT' || (attendee.params.CUTYPE && attendee.params.CUTYPE !== 'INDIVIDUAL')) invalid('Delegated or non-participant invitations must be answered in your calendar app.');
  if (forwarded || String(fromEmail || '').toLowerCase() !== organizer || (senderEmail && senderEmail.toLowerCase() !== organizer) || !recipients?.some(email => email.toLowerCase() === attendeeEmail)) invalid('The organizer or direct recipient could not be verified. Forwarded or delegated invitations must be answered in your calendar app.');
  if (organizer === attendeeEmail) invalid('The organizer cannot RSVP as an attendee here.');
  const canonical = prop => prop ? [prop.value, Object.entries(prop.params).sort(([a], [b]) => a.localeCompare(b))] : null;
  const recurrenceIdentity = event['RECURRENCE-ID'] ? [event['RECURRENCE-ID'].value, event['RECURRENCE-ID'].params.TZID || '', event['RECURRENCE-ID'].params.VALUE || 'DATE-TIME'] : null;
  return {
    uid: textValue(event.UID.value), sequence: Number(sequence), organizer, attendee: attendeeEmail, cancelled,
    recurrenceId: event['RECURRENCE-ID']?.raw || '',
    recurrenceIdentity,
    recurrenceRange: event['RECURRENCE-ID']?.params.RANGE || null,
    summary: textValue(event.SUMMARY?.value || 'Meeting invitation').slice(0, 500),
    start: event.DTSTART?.value, timeZone: event.DTSTART?.params.TZID || (event.DTSTART?.value.endsWith('Z') ? 'UTC' : null),
    dateOnly: event.DTSTART?.params.VALUE === 'DATE',
    eventLines: ['UID', 'DTSTART', 'DTEND', 'RECURRENCE-ID'].flatMap(name => event[name] ? [event[name].raw] : []),
    zones: zones.flat(),
    revision: digest([textValue(event.UID.value), Number(sequence), canonical(event['RECURRENCE-ID']), canonical(event.DTSTART), canonical(event.DTEND), canonical(event.DURATION), textValue(event.SUMMARY?.value), zones, organizer, attendeeEmail]),
  };
}

export function trustedInvitation(source, message, account) {
  const { text, headers, method } = calendarFromSource(source);
  if (!message.message_id || headers['message-id'] !== message.message_id) throw new InvitationError(409, 'The message on the server changed. Reload it before responding.', 'message_changed');
  const from = parseMailboxList(headers.from), sender = parseMailboxList(headers.sender);
  if (from.length !== 1 || sender.length > 1) invalid('The invitation sender is ambiguous.');
  return parseCalendarInvitation(text, {
    accountEmail: account.email_address, fromEmail: from[0].email, senderEmail: sender[0]?.email,
    recipients: [...parseMailboxList(headers.to), ...parseMailboxList(headers.cc)].map(a => a.email),
    forwarded: Object.keys(headers).some(key => key.startsWith('resent-')) || /^(?:fwd?|wg|tr):/i.test(headers.subject || ''),
    mimeMethod: method, includeCancellation: true,
  });
}

export function invitationKey(userId, accountId, invitation) {
  return `invitation_response:${digest([userId, accountId, invitation.organizer, invitation.uid, invitation.recurrenceIdentity, invitation.sequence])}`;
}

export function invitationSeriesKey(userId, accountId, invitation) {
  return `invitation_sequence:${digest([userId, accountId, invitation.organizer, invitation.uid, invitation.recurrenceIdentity])}`;
}

function foldLine(line) {
  const chunks = [];
  let current = '';
  for (const char of line) {
    if (Buffer.byteLength(current + char) > 75) { chunks.push(current); current = ' '; }
    current += char;
  }
  chunks.push(current);
  return chunks.join('\r\n');
}

export function buildCalendarReply(invitation, response, now = new Date()) {
  if (invitation.cancelled) throw new InvitationError(409, 'This meeting was cancelled.', 'cancelled_invitation');
  if (!RESPONSES.has(response)) throw new InvitationError(400, 'Choose Accept, Tentative, or Decline.', 'invalid_response');
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const summary = invitation.summary.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MailFlow//Invitation Reply//EN', 'METHOD:REPLY',
    ...invitation.zones, 'BEGIN:VEVENT', ...invitation.eventLines, `SEQUENCE:${invitation.sequence}`,
    `DTSTAMP:${stamp}`, `ORGANIZER:mailto:${invitation.organizer}`,
    `ATTENDEE;PARTSTAT=${response};RSVP=FALSE:mailto:${invitation.attendee}`,
    `SUMMARY:${summary}`, 'END:VEVENT', 'END:VCALENDAR',
  ].map(foldLine).join('\r\n') + '\r\n';
}
