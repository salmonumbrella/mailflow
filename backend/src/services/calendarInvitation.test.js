import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCalendarReply, calendarFromSource, invitationKey, invitationSeriesKey, parseCalendarInvitation, trustedInvitation, MAX_INVITATION_SOURCE_BYTES } from './calendarInvitation.js';

export const ics = readFileSync(new URL('./fixtures/invitation.ics', import.meta.url), 'utf8').replace(/\r?\n/g, '\r\n');
const context = { accountEmail: 'me@example.test', fromEmail: 'lead@example.test', recipients: ['me@example.test'] };
const parse = (text = ics, extra = {}) => parseCalendarInvitation(text, { ...context, ...extra });
const mime = (content = ics, headers = '') => Buffer.from(`Message-ID: <invite@example.test>\r\nFrom: Project Lead <lead@example.test>\r\nTo: Me <me@example.test>\r\n${headers}Content-Type: text/calendar; charset=utf-8; method=REQUEST\r\n\r\n${content}`);

describe('trusted invitation and RFC 5545/5546 reply', () => {
  it('preserves UID/sequence and sends one owned attendee to its organizer without forwarding other content', () => {
    const invite = parse();
    const reply = buildCalendarReply(invite, 'ACCEPTED', new Date('2026-11-10T16:04:05Z'));
    expect(reply).toContain('METHOD:REPLY\r\n');
    expect(reply).toContain('SEQUENCE:3\r\n');
    expect(reply).toContain('UID:planning-2026@example.test');
    expect(reply).toContain('DTSTAMP:20261110T160405Z');
    expect(reply).toContain('ATTENDEE;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:me@example.test');
    expect(reply).not.toContain('colleague');
    expect(reply).not.toContain('DESCRIPTION');
    expect(reply).not.toContain('VALARM');
    expect(invite.summary).toBe('Planning, next steps');
  });
  it.each(['ACCEPTED', 'TENTATIVE', 'DECLINED'])('supports the %s participation state', response => {
    expect(buildCalendarReply(parse(), response)).toContain(`PARTSTAT=${response}`);
  });
  it('rejects invented participation states', () => expect(() => buildCalendarReply(parse(), 'SENT')).toThrow('Choose Accept'));
  it('preserves an all-day recurring occurrence and canonicalizes parameter order for idempotency', () => {
    const start = ics.replace('DTSTART:20261112T140000Z', 'DTSTART;VALUE=DATE:20261112').replace('DTEND:20261112T143000Z', 'DTEND;VALUE=DATE:20261113');
    const first = parse(start.replace('SEQUENCE:3', 'SEQUENCE:3\r\nRECURRENCE-ID;VALUE=DATE;RANGE=THISANDFUTURE:20261112'));
    const second = parse(start.replace('SEQUENCE:3', 'SEQUENCE:3\r\nRECURRENCE-ID;RANGE=THISANDFUTURE;VALUE=DATE:20261112'));
    expect(buildCalendarReply(first, 'TENTATIVE')).toContain(first.recurrenceId);
    expect(invitationKey('u', 'a', first)).toBe(invitationKey('u', 'a', second));
    expect(first.dateOnly).toBe(true);
  });
  it('keeps time-zone definitions for a time-zoned recurrence and never returns a TZURL', () => {
    const zone = 'BEGIN:VTIMEZONE\r\nTZID:America/New_York\r\nTZURL:https://tracker.invalid/x\r\nBEGIN:STANDARD\r\nDTSTART:20261101T020000\r\nTZOFFSETFROM:-0400\r\nTZOFFSETTO:-0500\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n';
    const invite = parse(ics.replace('BEGIN:VEVENT', `${zone}BEGIN:VEVENT`).replace('DTSTART:20261112T140000Z', 'DTSTART;TZID="America/New_York":20261112T090000').replace('SEQUENCE:3', 'SEQUENCE:3\r\nRECURRENCE-ID;TZID="America/New_York":20261112T090000'));
    expect(buildCalendarReply(invite, 'DECLINED')).toContain('TZID:America/New_York');
    expect(buildCalendarReply(invite, 'DECLINED')).not.toContain('tracker.invalid');
  });
  it('handles folded Unicode text and quoted parameter delimiters, folding replies at 75 UTF-8 bytes', () => {
    const invite = parse(ics.replace('CN="Mailbox owner"', 'CN="Owner: One; Team"').replace('Planning\\, next steps', `A quote " and ${'é'.repeat(60)}\r\n continued`));
    expect(invite.summary).toContain('continued');
    for (const line of buildCalendarReply(invite, 'ACCEPTED').split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  });
  it('scopes deduplication to user, account, organizer, revision and recurrence', () => {
    const invite = parse();
    const keys = [invitationKey('u', 'a', invite), invitationKey('u2', 'a', invite), invitationKey('u', 'a2', invite), invitationKey('u', 'a', { ...invite, sequence: 4 }), invitationKey('u', 'a', { ...invite, recurrenceIdentity: ['20261112T140000Z', '', '', ''] })];
    expect(new Set(keys).size).toBe(5);
    expect(invitationSeriesKey('u', 'a', invite)).toBe(invitationSeriesKey('u', 'a', { ...invite, sequence: 4 }));
  });
  it.each([
    ['cancellation', text => text.replace('METHOD:REQUEST', 'METHOD:CANCEL')],
    ['cancelled status', text => text.replace('SEQUENCE:3', 'SEQUENCE:3\r\nSTATUS:CANCELLED')],
    ['reply', text => text.replace('METHOD:REQUEST', 'METHOD:REPLY')],
    ['multiple events', text => text.replace('END:VCALENDAR', 'BEGIN:VEVENT\r\nUID:two\r\nEND:VEVENT\r\nEND:VCALENDAR')],
    ['duplicate organizer', text => text.replace('SEQUENCE:3', 'SEQUENCE:3\r\nORGANIZER:mailto:other@example.test')],
    ['invalid date', text => text.replace('20261112T140000Z', '20260231T140000Z')],
    ['missing UID', text => text.replace('UID:planning-2026@example.test\r\n', '')],
    ['duplicate matching attendee', text => text.replace('SEQUENCE:3', 'SEQUENCE:3\r\nATTENDEE:mailto:me@example.test')],
    ['delegated organizer', text => text.replace('ORGANIZER;CN=', 'ORGANIZER;SENT-BY="mailto:delegate@example.test";CN=')],
    ['delegated attendee', text => text.replace('PARTSTAT=NEEDS-ACTION', 'DELEGATED-TO="mailto:other@example.test"')],
    ['header injection', text => text.replace('mailto:lead@example.test', 'mailto:lead@example.test?bcc=bad@example.test')],
    ['nested event', text => text.replace('BEGIN:VALARM', 'BEGIN:VEVENT')],
    ['unclosed event', text => text.replace('END:VEVENT\r\n', '')],
    ['extra document', text => `${text}BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n`],
  ])('rejects %s', (_name, change) => expect(() => parse(change(ics))).toThrow());
  it.each([
    { accountEmail: 'alias@example.test' }, { fromEmail: 'forwarder@example.test' },
    { senderEmail: 'delegate@example.test' }, { forwarded: true }, { recipients: ['other@example.test'] }, { mimeMethod: 'CANCEL' },
  ])('rejects unowned or ambiguous source identity %j', extra => expect(() => parse(ics, extra)).toThrow());
  it('reads a direct MIME calendar and verifies the owned message identity', () => {
    expect(trustedInvitation(mime(), { message_id: '<invite@example.test>' }, { email_address: 'me@example.test' }).organizer).toBe('lead@example.test');
    expect(() => trustedInvitation(mime(), { message_id: '<other@example.test>' }, { email_address: 'me@example.test' })).toThrow('server changed');
    expect(() => trustedInvitation(mime(ics, 'Resent-From: forwarder@example.test\r\n'), { message_id: '<invite@example.test>' }, { email_address: 'me@example.test' })).toThrow('Forwarded');
  });
  it.each(['base64', 'quoted-printable'])('reads %s calendar MIME nested with HTML', encoding => {
    const content = encoding === 'base64' ? Buffer.from(ics).toString('base64') : ics.replace(/=/g, '=3D').replace('Planning', 'Plan=\r\nning');
    const raw = Buffer.from(`From: lead@example.test\r\nContent-Type: multipart/alternative; boundary="calendar-boundary"\r\n\r\n--calendar-boundary\r\nContent-Type: text/html\r\n\r\n<b>Invite</b>\r\n--calendar-boundary\r\nContent-Type: text/calendar; method=REQUEST\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n${content}\r\n--calendar-boundary--\r\n`);
    expect(parse(calendarFromSource(raw).text).uid).toBe('planning-2026@example.test');
  });
  it('does not traverse attached forwarded messages', () => expect(() => calendarFromSource(Buffer.from('Content-Type: message/rfc822\r\n\r\n' + mime()))).toThrow('Forwarded'));
  it('rejects oversized source before parsing', () => expect(() => calendarFromSource(Buffer.alloc(MAX_INVITATION_SOURCE_BYTES + 1))).toThrow('too large'));
});
