#!/usr/bin/env node
// Isolated, in-memory browser QA fixture. Never imports the backend or connects to a provider.
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = '2026-11-10';
export function createFixtureState() {
  const accounts = [
    { id: 'fixture-work', email: 'alex@northstar.example', display_name: 'Northstar', color: '#7565e8' },
    { id: 'fixture-personal', email: 'alex@personal.example', display_name: 'Personal', color: '#54b8a2' },
  ].map(a => ({ ...a, email_address: a.email, enabled: true, include_in_unified_inbox: true, connection_status: 'connected',
    categorization_enabled: true, folder_mappings: { sent: 'Sent', drafts: 'Drafts', archive: 'Archive', trash: 'Trash', junk: 'Junk' } }));
  const rows = [
    ['Maya Chen', 'maya@northstar.example', 'Launch review: final details', 'The updated launch checklist is ready for our review. I added a short summary of the remaining decisions.', 'primary', false, true],
    ['Jordan Ellis', 'jordan@design.example', 'A quieter workspace', 'A few visual refinements to the new workspace. The latest direction gives the content more room to breathe.', 'primary', false, false],
    ['Sam Rivera', 'sam@northstar.example', 'Tomorrow’s planning session', 'Sharing the agenda for tomorrow. Let’s make time for the customer feedback and the next milestone.', 'primary', true, false],
    ['Priya Shah', 'priya@research.example', 'Notes from the research sprint', 'Three themes stood out in the interviews. I have collected the useful quotes and next steps below.', 'primary', true, true],
    ['The Field Notes', 'editor@fieldnotes.example', 'Good ideas, delivered slowly', 'This week: thoughtful tools, small teams, and the value of a well-designed everyday ritual.', 'newsletter', false, false],
    ['Northstar Updates', 'updates@northstar.example', 'Weekly project digest', 'Your weekly summary is here. The prototype is ready and the documentation has been updated.', 'automated', false, false],
    ['Studio Supply', 'hello@studio.example', 'New essentials for your desk', 'A small collection of useful objects designed to make the working day a little more pleasant.', 'promotion', true, false],
    ['Alex Morgan', 'alex@personal.example', 'Saturday by the coast', 'A slow morning, a good walk, and lunch at the little place near the harbor. Does that sound good?', 'primary', false, false],
    ['Community Studio', 'team@community.example', 'Your workshop is confirmed', 'We look forward to seeing you next week. Here is everything you need to know before the workshop.', 'automated', true, false],
  ];
  const messages = rows.map((r, i) => ({ id: `fixture-message-${i + 1}`, uid: i + 1,
    account_id: i >= 7 ? accounts[1].id : accounts[0].id, account_email: i >= 7 ? accounts[1].email : accounts[0].email,
    folder: 'INBOX', from_name: r[0], from_email: r[1], subject: r[2], snippet: r[3], category: r[4],
    is_read: r[5], is_starred: r[6], date: `${DAY}T${String(12 - i).padStart(2, '0')}:15:00Z`,
    message_id: `<fixture-${i + 1}@mailflow.example>`, thread_key: `<fixture-${i + 1}@mailflow.example>`, thread_id: `<fixture-${i + 1}@mailflow.example>`,
    thread_count: 1, message_count: 1, unread_count: r[5] ? 0 : 1, has_attachments: false,
    to_addresses: [{ name: 'Alex Morgan', email: i >= 7 ? accounts[1].email : accounts[0].email,
      address: i >= 7 ? accounts[1].email : accounts[0].email }], cc_addresses: [],
  }));
  return { accounts, messages, preferences: { theme: 'dark', layout: 'comfortable', font: 'default',
    language: 'en', categorizationEnabled: true, threadedView: false, enabledPlugins: [], showAvatars: true,
    remoteImages: false, autoOpenReplyDrafts: false, savedSplits: [], hideEmptySplits: false, savedSplitsRevision: 0 },
    snippets: [], mutedThreads: {}, privateNotes: {}, calendar: { calendars: [], templates: [], timezone: 'UTC', weekStart: 1, revision: null },
    events: [], mutations: [], sent: [], drafts: [], requests: [] };
}

const fixturePlugins = [
  { id: 'local-calendar', name: 'MailFlow calendar', version: '1.0.0', tier: 1 },
  { id: 'private-notes', name: 'Private thread notes', version: '1.0.0', tier: 1 },
];

// Local accessory screens have the same in-memory-only isolation as the mail fixtures.
function handleAccessoryApi(state, method, pathname, query, body) {
  state.mutedThreads ||= {};
  const ok = body => ({ status: 200, body });
  const error = (status, error) => ({ status, body: { error } });
  if (method === 'GET' && pathname === '/api/plugins') return ok(fixturePlugins.map(plugin => ({ ...plugin, activated: state.preferences.enabledPlugins.includes(plugin.id) })));
  const mutedMessage = pathname.match(/^\/api\/mail\/messages\/(fixture-message-\d+)\/mute$/)?.[1];
  if (mutedMessage) {
    const message = state.messages.find(item => item.id === mutedMessage);
    if (!message) return error(404, 'Message not found');
    const key = `${message.account_id}:${message.thread_key}`;
    const current = state.mutedThreads[key] || { muted: false, revision: null, threadKey: message.thread_key };
    if (method === 'GET') return ok(structuredClone(current));
    if (method === 'PATCH') {
      if (typeof body.muted !== 'boolean') return error(400, 'Invalid mute state');
      if (body.revision !== current.revision) return error(409, 'Mute state changed');
      state.mutedThreads[key] = { muted: body.muted, revision: createHash('sha256').update(randomUUID()).digest('hex'), threadKey: message.thread_key };
      return ok(structuredClone(state.mutedThreads[key]));
    }
  }
  if (pathname === '/api/mail/muted' && method === 'GET') {
    const messages = state.messages.filter(message => (!query.get('account_id') || message.account_id === query.get('account_id'))
      && state.mutedThreads[`${message.account_id}:${message.thread_key}`]?.muted);
    const offset = Number(query.get('offset') || 0);
    return ok({ messages: structuredClone(messages.slice(offset, offset + 100)), hasMore: messages.length > offset + 100, nextOffset: messages.length > offset + 100 ? offset + 100 : null });
  }
  const activation = pathname.match(/^\/api\/plugins\/([^/]+)$/);
  if (method === 'PATCH' && activation) {
    const id = activation[1];
    if (!fixturePlugins.some(plugin => plugin.id === id)) return error(404, 'Unknown fixture plugin');
    if (typeof body.activated !== 'boolean') return error(400, 'activated must be boolean');
    state.preferences.enabledPlugins = body.activated ? [...new Set([...state.preferences.enabledPlugins, id])]
      : state.preferences.enabledPlugins.filter(value => value !== id);
    return ok({ id, activated: body.activated });
  }
  const plugin = pathname.startsWith('/api/local-calendar/') ? 'local-calendar' : pathname.startsWith('/api/private-notes/') ? 'private-notes' : null;
  if (plugin && !state.preferences.enabledPlugins.includes(plugin)) return error(403, 'Enable this plugin first');
  if (pathname === '/api/local-calendar/catalog') {
    if (method === 'GET') return ok(structuredClone(state.calendar));
    if (method === 'PUT') {
      if (body.revision !== state.calendar.revision) return error(409, 'Calendar settings changed');
      if (!Array.isArray(body.calendars) || body.calendars.length > 20 || !Array.isArray(body.templates) || body.templates.length > 50) return error(400, 'Invalid fixture calendar');
      state.calendar = { ...structuredClone(body), revision: randomUUID() };
      state.events = state.events.filter(event => body.calendars.some(calendar => calendar.id === event.calendarId));
      return ok(structuredClone(state.calendar));
    }
  }
  if (pathname === '/api/local-calendar/events' && method === 'GET') {
    const start = Date.parse(query.get('start')), end = Date.parse(query.get('end'));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 100 * 86400000) return error(400, 'Invalid fixture range');
    return ok({ items: structuredClone(state.events.filter(event => Date.parse(event.start) < end && Date.parse(event.end) > start)), nextCursor: null });
  }
  const eventId = pathname.match(/^\/api\/local-calendar\/events\/([^/]+)$/)?.[1];
  if ((pathname === '/api/local-calendar/events' && method === 'POST') || (eventId && ['PUT', 'DELETE'].includes(method))) {
    const existing = state.events.find(event => event.id === eventId);
    if (eventId && !existing) return error(404, 'Event not found');
    if (existing && existing.revision !== (method === 'DELETE' ? query.get('revision') : body.revision)) return error(409, 'Event changed');
    if (method === 'DELETE') { state.events = state.events.filter(event => event.id !== eventId); return ok({ ok: true }); }
    if (!state.calendar.calendars.some(calendar => calendar.id === body.calendarId) || typeof body.title !== 'string' || !body.title.trim()
      || !Number.isFinite(Date.parse(body.start)) || !Number.isFinite(Date.parse(body.end)) || Date.parse(body.end) <= Date.parse(body.start)) return error(400, 'Invalid fixture event');
    const saved = { ...structuredClone(body), id: eventId || randomUUID(), revision: randomUUID() };
    state.events = existing ? state.events.map(event => event === existing ? saved : event) : [...state.events, saved];
    return { status: existing ? 200 : 201, body: structuredClone(saved) };
  }
  const notes = pathname.match(/^\/api\/private-notes\/(fixture-message-\d+)(?:\/([^/]+))?$/);
  if (notes) {
    const message = state.messages.find(message => message.id === notes[1]);
    if (!message) return error(404, 'Message not found');
    const key = `${message.account_id}:${message.thread_id}`;
    const record = state.privateNotes[key] || { notes: [], version: null };
    const snapshot = () => structuredClone({ notes: record.notes.filter(note => !note.deletedAt), version: record.version });
    if (method === 'GET') return ok(snapshot());
    if (method === 'POST') {
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000 || typeof body.requestId !== 'string') return error(400, 'Invalid note');
      if (record.notes.some(note => note.id === body.requestId)) return ok(snapshot());
      if (body.version !== record.version) return error(409, 'Notes changed');
      record.notes.push({ id: body.requestId, text: body.text.trim(), createdAt: new Date().toISOString() });
      record.version = randomUUID(); state.privateNotes[key] = record;
      return { status: 201, body: snapshot() };
    }
    if (method === 'DELETE' && notes[2]) {
      const note = record.notes.find(note => note.id === notes[2]);
      if (!note) return error(404, 'Note not found');
      if (!note.deletedAt && body.version !== record.version) return error(409, 'Notes changed');
      if (!note.deletedAt) { delete note.text; note.deletedAt = new Date().toISOString(); record.version = randomUUID(); }
      return ok(snapshot());
    }
  }
  return null;
}

function counts(state) {
  const byAccount = Object.fromEntries(state.accounts.map(a => [a.id, state.messages.filter(m => m.account_id === a.id && m.folder === 'INBOX' && !m.is_read).length]));
  return { byAccount, total: Object.values(byAccount).reduce((a, b) => a + b, 0), complete: true,
    snoozed: state.messages.filter(m => m.folder === 'Snoozed').length,
    snapshots: Object.fromEntries(state.accounts.map(a => [a.id, { known: true, stale: false, observedAt: new Date().toISOString(), revision: String(state.mutations.length + 1) }])) };
}
function folderRows(state, id) {
  return ['INBOX', 'Sent', 'Drafts', 'Archive', 'Trash', 'Junk', 'Snoozed'].map((name, i) => ({
    id: `${id}-folder-${i}`, account_id: id, path: name, name, delimiter: '/',
    special_use: name === 'INBOX' ? '\\Inbox' : `\\${name}`, counts_known: true, counts_stale: false,
    total_count: state.messages.filter(m => m.account_id === id && m.folder === name).length,
    unread_count: state.messages.filter(m => m.account_id === id && m.folder === name && !m.is_read).length,
    server_counts_at: new Date().toISOString(), server_count_revision: '1', status_attempt_revision: '1',
  }));
}
function listMessages(state, query, search = false) {
  let messages = state.messages.filter(m => !query.get('accountId') || m.account_id === query.get('accountId'));
  const searchText = query.get('q') || '';
  const inFolder = search && /(?:^|\s)in:(?:"([^"]+)"|(\S+))/i.exec(searchText);
  messages = messages.filter(m => search && (inFolder || !query.get('folder')) ? true : m.folder === (query.get('folder') || 'INBOX'));
  if (query.get('category') && query.get('category') !== 'all') messages = messages.filter(m => m.category === query.get('category'));
  if (query.get('unreadOnly') === 'true') messages = messages.filter(m => !m.is_read);
  if (search) messages = messages.filter(message => fixtureSearchMatches(message, searchText));
  const total = messages.length, offset = Number(query.get('offset') || 0), limit = Number(query.get('limit') || 50);
  return { messages: messages.slice(offset, offset + limit), total };
}

// The fixture implements the small native query subset used by its browser scenarios.
// Production search/compiler parity is covered by separate PostgreSQL tests, not this helper.
function fixtureSearchMatches(message, query) {
  const terms = [...query.matchAll(/(-?)(?:(from|to|subject|is|has|in|after|before):)?("[^"]*"|\S+)/gi)];
  const includes = (haystack, needle) => String(haystack || '').toLowerCase().includes(needle);
  return terms.every(([, negative, field, raw]) => {
    const value = raw.replace(/^"|"$/g, '').toLowerCase();
    let matches;
    switch (field?.toLowerCase()) {
      case 'from': matches = includes(`${message.from_name} ${message.from_email}`, value); break;
      case 'to': matches = includes(message.to_addresses.map(person => `${person.name || ''} ${person.email || person.address}`).join(' '), value); break;
      case 'subject': matches = includes(message.subject, value); break;
      case 'is': matches = { unread: !message.is_read, read: message.is_read, starred: message.is_starred, unstarred: !message.is_starred }[value] === true; break;
      case 'has': matches = ['attachment', 'attachments'].includes(value) && message.has_attachments; break;
      case 'in': matches = value === 'all' || message.folder.toLowerCase() === value; break;
      case 'after': matches = Number.isFinite(Date.parse(value)) && Date.parse(message.date) > Date.parse(value); break;
      case 'before': matches = Number.isFinite(Date.parse(value)) && Date.parse(message.date) < Date.parse(value); break;
      default: matches = includes(`${message.subject} ${message.snippet} ${message.from_name} ${message.from_email}`, value);
    }
    return negative ? !matches : matches;
  });
}
function messageBody(m) {
  return { html: `<div style="font-family:Arial,sans-serif;line-height:1.7;color:#263043;padding:20px"><p>Hi Alex,</p><p>${m.snippet}</p><p>Everything here is fictional local test data. No mail service is connected.</p><p>Thanks,<br>${m.from_name}</p></div>`,
    text: `Hi Alex,\n\n${m.snippet}\n\nEverything here is fictional local test data. No mail service is connected.\n\nThanks,\n${m.from_name}`,
    attachments: [], remoteImagesBlocked: false, remoteImagesProxied: false };
}
export function handleFixtureApi(state, method, pathname, query, body = {}) {
  state.requests.push({ method, pathname, query: Object.fromEntries(query) });
  const accessory = handleAccessoryApi(state, method, pathname, query, body);
  if (accessory) return accessory;
  const ok = value => ({ status: 200, body: value });
  const publicSnippet = item => { const result = { ...item }; delete result.usageRequestIds; return result; };
  if (method === 'GET') {
    if (pathname === '/api/__fixture/state') return ok(state);
    if (pathname === '/api/auth/me') return ok({ user: { id: 'fixture-user', username: 'Alex Morgan', email: 'alex@northstar.example', is_admin: false, display_name: 'Alex Morgan' } });
    if (pathname === '/api/auth/preferences') return ok(state.preferences);
    if (pathname === '/api/auth/preferences/saved-splits') return ok({ savedSplits: state.preferences.savedSplits,
      hideEmptySplits: state.preferences.hideEmptySplits, savedSplitsRevision: state.preferences.savedSplitsRevision });
    if (pathname === '/api/snippets') return ok({ snippets: state.snippets.map(publicSnippet) });
    if (pathname === '/api/open-activity/capabilities') return ok({ available: false, defaultEnabled: false, retentionDays: 30, notice: 'This local fixture never sends mail or records recipient activity.' });
    if (pathname === '/api/open-activity') return ok({ activity: [], notice: 'This local fixture never sends mail or records recipient activity.' });
    if (pathname.startsWith('/api/open-activity/message/')) return ok({ activity: null });
    if (pathname === '/api/accounts') return ok(state.accounts);
    if (/^\/api\/accounts\/[^/]+\/folders$/.test(pathname)) return ok(folderRows(state, pathname.split('/')[3]));
    if (/^\/api\/accounts\/[^/]+\/aliases$/.test(pathname)) return ok([]);
    if (pathname === '/api/mail/unread-counts') return ok(counts(state));
    if (pathname === '/api/mail/messages') return ok(listMessages(state, query));
    if (pathname === '/api/mail/resolve-message') {
      const ref = query.get('ref');
      const message = state.messages.find(message => (message.id === ref || message.message_id === ref)
        && (!query.get('accountId') || message.account_id === query.get('accountId')));
      return message ? ok(structuredClone(message)) : { status: 404, body: { error: 'Message not found' } };
    }
    if (pathname === '/api/search') return ok(listMessages(state, query, true));
    if (pathname === '/api/search/splits') {
      const counts = Object.fromEntries(state.preferences.savedSplits.map(split => {
        const scope = new URLSearchParams(query); scope.set('q', split.query); scope.set('folder', 'INBOX'); scope.set('limit', '1000');
        const rows = listMessages(state, scope, true);
        return [split.id, { total: rows.total, unread: rows.messages.filter(m => !m.is_read).length }];
      }));
      return ok({ counts, savedSplitsRevision: state.preferences.savedSplitsRevision, source: 'synced-cache' });
    }
    if (pathname === '/api/search/contacts') return ok([]);
    if (pathname === '/api/mail/category-counts') {
      const rows = state.messages.filter(m => m.folder === 'INBOX' && (!query.get('accountId') || m.account_id === query.get('accountId')));
      const totals = {}, unread = {};
      for (const m of rows) { totals[m.category] = (totals[m.category] || 0) + 1; if (!m.is_read) unread[m.category] = (unread[m.category] || 0) + 1; }
      return ok({ totals, counts: unread });
    }
    if (pathname === '/api/mail/thread') return ok({ messages: state.messages.filter(m => m.thread_id === query.get('id')) });
    const match = pathname.match(/^\/api\/mail\/messages\/(fixture-message-\d+)(?:\/(body|reply-draft|bcc|headers))?$/);
    if (match) {
      const m = state.messages.find(m => m.id === match[1]);
      if (!m) return { status: 404, body: { error: 'Fixture message not found' } };
      return ok(match[2] === 'body' ? messageBody(m) : match[2] === 'reply-draft' ? { exists: false, draft: null } : match[2] === 'bcc' ? { bcc: [] } : m);
    }
    if (pathname === '/api/todoist/status') return ok({ connected: false });
    if (pathname === '/api/update') return ok({ updateAvailable: false, currentVersion: '4.3.1' });
    if (pathname === '/api/mail/scheduled') return ok({ messages: [], total: 0 });
    if (pathname === '/api/contacts') return ok({ contacts: [], total: 0 });
    if (['/api/integrations', '/api/rules', '/api/categories/sources'].includes(pathname)) return ok([]);
    if (pathname === '/api/ai/status') return ok({ enabled: false, available: false });
  }
  if (method === 'PATCH' && pathname === '/api/auth/preferences') { Object.assign(state.preferences, body); return ok(state.preferences); }
  if (method === 'PUT' && pathname === '/api/auth/preferences/saved-splits') {
    if (body.savedSplitsRevision !== state.preferences.savedSplitsRevision) return { status: 409, body: { error: 'Saved splits changed. Reload and try again.' } };
    const splits = body.savedSplits;
    if (!Array.isArray(splits) || splits.length > 12 || typeof body.hideEmptySplits !== 'boolean'
      || splits.some(s => !s || typeof s.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(s.id) || typeof s.label !== 'string' || !s.label.trim() || s.label.trim().length > 60
        || typeof s.query !== 'string' || !s.query.trim() || s.query.trim().length > 500 || /[\u0000-\u001f\u007f]/.test(s.label + s.query))
      || new Set(splits.map(s => s.id)).size !== splits.length
      || new Set(splits.map(s => s.label.trim().toLowerCase())).size !== splits.length) return { status: 400, body: { error: 'Invalid saved splits' } };
    state.preferences.savedSplits = splits.map(s => ({ id: s.id, label: s.label.trim(), query: s.query.trim() }));
    state.preferences.hideEmptySplits = body.hideEmptySplits;
    state.preferences.savedSplitsRevision++;
    return ok({ savedSplits: state.preferences.savedSplits, hideEmptySplits: state.preferences.hideEmptySplits, savedSplitsRevision: state.preferences.savedSplitsRevision });
  }
  const snippetUseId = pathname.match(/^\/api\/snippets\/([^/]+)\/use$/)?.[1];
  if (snippetUseId && method === 'POST') {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid.test(snippetUseId) || typeof body.requestId !== 'string' || !uuid.test(body.requestId)) return { status: 400, body: { error: 'Invalid usage request' } };
    const snippet = state.snippets.find(item => item.id === snippetUseId);
    if (!snippet) return { status: 404, body: { error: 'Snippet not found' } };
    const requests = snippet.usageRequestIds || [];
    if (!requests.includes(body.requestId)) {
      snippet.usageCount = Math.min(Number.MAX_SAFE_INTEGER, (snippet.usageCount || 0) + 1);
      snippet.lastUsedAt = new Date().toISOString();
      snippet.usageRequestIds = [...requests, body.requestId].slice(-64);
    }
    return ok(publicSnippet(snippet));
  }
  const snippetId = pathname.match(/^\/api\/snippets\/([^/]+)$/)?.[1];
  if ((pathname === '/api/snippets' && method === 'POST') || (snippetId && ['PUT', 'DELETE'].includes(method))) {
    const snippet = state.snippets.find(s => s.id === snippetId);
    if (snippetId && !snippet) return { status: 404, body: { error: 'Snippet not found' } };
    if (snippet && Number(method === 'DELETE' ? query.get('version') : body.version) !== snippet.version) return { status: 409, body: { error: 'Snippet changed. Reload and try again.' } };
    if (method === 'DELETE') { state.snippets = state.snippets.filter(s => s !== snippet); return { status: 204 }; }
    const subject = body.subject === undefined ? '' : body.subject;
    if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 120 || typeof body.body !== 'string' || !body.body.trim() || body.body.length > 20000
      || typeof subject !== 'string' || subject.length > 200 || (body.format !== undefined && body.format !== 'text')
      || !body.title.isWellFormed() || !body.body.isWellFormed() || !subject.isWellFormed()
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.title + body.body + subject)
      || /[\r\n\t]/.test(body.title + subject)) return { status: 400, body: { error: 'Invalid snippet' } };
    if (!snippet && state.snippets.length >= 50) return { status: 409, body: { error: 'Snippet limit reached' } };
    const now = new Date().toISOString();
    const saved = { ...(snippet || { usageCount: 0, lastUsedAt: null, createdAt: now }), id: snippet?.id || randomUUID(),
      title: body.title.trim(), subject: subject.trim(), body: body.body.replace(/\r\n?/g, '\n'), format: 'text', version: (snippet?.version || 0) + 1, updatedAt: now };
    state.snippets = snippet ? state.snippets.map(s => s === snippet ? saved : s) : [...state.snippets, saved];
    return { status: method === 'POST' ? 201 : 200, body: publicSnippet(saved) };
  }
  if (method === 'POST' && pathname === '/api/mail/reply-drafts/indicators') return ok({ indicators: {} });
  if (method === 'POST' && ['/api/mail/sync-folder', '/api/mail/sync-folders', '/api/mail/sync'].includes(pathname)) return ok({ success: true, fixture: true });
  const bulk = pathname.match(/^\/api\/mail\/messages\/bulk-(read|star|archive|move|delete)$/);
  const single = pathname.match(/^\/api\/mail\/messages\/(fixture-message-\d+)\/(star|snooze|unsnooze)$/);
  if ((method === 'POST' && bulk) || (['POST', 'PATCH'].includes(method) && single)) {
    const rows = state.messages.filter(m => bulk ? (body.ids || []).includes(m.id) : m.id === single[1]);
    const op = bulk?.[1] || single[2];
    if (op === 'archive' && body.muteGuard) {
      const guard = body.muteGuard;
      const target = state.messages.find(message => message.id === guard.messageId);
      const record = target && state.mutedThreads[`${target.account_id}:${target.thread_key}`];
      if (!target || !record?.muted || record.revision !== guard.revision || target.account_id !== guard.accountId || target.thread_key !== guard.threadKey
        || !rows.length || rows.length !== body.ids?.length || rows.some(message => message.account_id !== guard.accountId || message.thread_key !== guard.threadKey || message.folder !== 'INBOX')) return { status: 409, body: { error: 'Muted inbox conversation changed' } };
    }
    for (const m of rows) {
      if (op === 'read') { m.is_read = body.read; m.unread_count = body.read ? 0 : 1; }
      if (op === 'star') m.is_starred = body.starred;
      if (op === 'archive') m.folder = 'Archive';
      if (op === 'move') m.folder = body.folder;
      if (op === 'delete') m.folder = 'Trash';
      if (op === 'snooze') { m.folder = 'Snoozed'; m.snooze_until = body.until; }
      if (op === 'unsnooze') { m.folder = 'INBOX'; delete m.snooze_until; }
    }
    state.mutations.push({ method, pathname, body: structuredClone(body) });
    return ok(op === 'archive' ? { archived: rows.map(message => message.id), noArchiveFolder: [] } : { success: true, fixture: true });
  }
  if (method === 'POST' && pathname === '/api/mail/draft') { state.drafts.push(structuredClone(body)); return ok({ uid: 1000 + state.drafts.length, folder: 'Drafts', fixture: true }); }
  if (method === 'DELETE' && pathname.startsWith('/api/mail/draft/')) return ok({ success: true, fixture: true });
  // Explicitly refuse delivery rather than making a test UI look like an actual send succeeded.
  if (pathname.includes('/send')) { state.sent.push({ method, pathname, body: structuredClone(body), delivered: false }); return { status: 409, body: { error: 'Fixture-only server: delivery is disabled. No message was sent.' } }; }
  return { status: 501, body: { error: `Unsupported fixture route: ${method} ${pathname}` } };
}

export async function createFixtureServer({ dist = path.join(ROOT, 'frontend/dist'), state = createFixtureState() } = {}) {
  const root = await realpath(dist);
  const server = http.createServer(async (req, res) => {
    const hostname = (req.headers.host || '').split(':')[0];
    if (!['127.0.0.1', 'localhost'].includes(hostname)) { res.writeHead(403); res.end('Loopback host only'); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-MailFlow-Fixture', 'fictional-local-only');
    // Block external fonts, images and connections even if UI defaults change.
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403); res.end('Same origin only'); return; }
        if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-requested-with'] !== 'MailFlow') { res.writeHead(403); res.end('Fixture mutation header required'); return; }
        let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 1024 * 1024) throw new Error('Fixture request too large'); }
        const result = handleFixtureApi(state, req.method, url.pathname, url.searchParams, raw ? JSON.parse(raw) : {});
        res.writeHead(result.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result.body)); return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
      const requested = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (requested !== root && !requested.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
      let file = requested;
      try { if (!(await stat(file)).isFile()) file = path.join(root, 'index.html'); } catch { file = path.join(root, 'index.html'); }
      const resolved = await realpath(file);
      if (!resolved.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime }); res.end(await readFile(file));
    } catch (err) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })); }
  });
  // A valid local close prevents retry spam without simulating backend events.
  server.on('upgrade', (req, socket) => {
    if (req.url !== '/ws' || !req.headers['sec-websocket-key']) { socket.destroy(); return; }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.end(Buffer.from([0x88, 0x02, 0x0f, 0xa3])); // 4003: intentionally disconnected fixture.
  });
  return { server, state, listen: port => new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server.address()))) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
  const fixture = await createFixtureServer({ dist: option('--dist', path.join(ROOT, 'frontend/dist')) });
  const address = await fixture.listen(Number(option('--port', 4173)));
  console.log(`FICTIONAL LOCAL FIXTURE http://127.0.0.1:${address.port} (no mail providers or delivery)`);
}
