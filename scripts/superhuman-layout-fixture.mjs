#!/usr/bin/env node
// Isolated, in-memory browser QA fixture. Never imports the backend or connects to a provider.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = '2026-11-11';
export function createFixtureState() {
  const accounts = [
    { id: 'fixture-work', email: 'alex@northstar.example', name: 'Northstar', sender_name: 'Alex Morgan', color: '#7565e8' },
    { id: 'fixture-personal', email: 'alex@personal.example', name: 'Personal', sender_name: 'Alex Morgan', color: '#54b8a2' },
  ].map(a => ({ ...a, email_address: a.email, protocol: 'imap', enabled: true, include_in_unified_inbox: true, connection_status: 'connected',
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
  accounts[0].signature = '<p>Alex Morgan · Fictional QA signature</p>';
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
    remoteImages: false, autoOpenReplyDrafts: false },
    mutations: [], sent: [], drafts: [], requests: [] };
}

function counts(state) {
  const byAccount = Object.fromEntries(state.accounts.map(a => [a.id, state.messages.filter(m => m.account_id === a.id && m.folder === 'INBOX' && !m.is_read).length]));
  return { byAccount, total: Object.values(byAccount).reduce((a, b) => a + b, 0), complete: true,
    snoozed: state.messages.filter(m => m.folder === 'Snoozed').length,
    snapshots: Object.fromEntries(state.accounts.map(a => [a.id, { known: true, stale: false, observedAt: new Date().toISOString(), revision: String(state.mutations.length + 1) }])) };
}
function folderRows(state, id) {
  return ['INBOX', 'Sent', 'Drafts', 'Archive', 'Trash', 'Junk', 'Snoozed', 'Projects'].map((name, i) => ({
    id: `${id}-folder-${i}`, account_id: id, path: name, name, delimiter: '/',
    special_use: name === 'Projects' ? null : name === 'INBOX' ? '\\Inbox' : `\\${name}`, counts_known: true, counts_stale: false,
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
// Only native baseline contracts used by visual QA are implemented. Unsupported
// routes fail closed. No speculative feature endpoint or provider capability is added.
export function handleFixtureApi(state, method, pathname, query, body = {}) {
  state.requests.push({ method, pathname, query: Object.fromEntries(query) });
  const ok = body => ({ status: 200, body });
  const fail = (status, error) => ({ status, body: { error } });
  // Record an attempted delivery only, never success. AI/integration calls fail closed.
  if (/\/send(?:$|[-/])|\/scheduled(?:$|\/)/.test(pathname) && method !== 'GET') {
    state.sent.push({ method, pathname, delivered: false });
    return fail(409, 'Fictional fixture: delivery and scheduling are disabled. No message was sent.');
  }
  if (method === 'GET') {
    if (pathname === '/api/auth/me') return ok({ user: { id: 'fixture-user', username: 'Alex Morgan', email: 'alex@northstar.example', is_admin: false, display_name: 'Alex Morgan' } });
    if (pathname === '/api/auth/preferences') return ok(structuredClone(state.preferences));
    if (pathname === '/api/accounts') return ok(structuredClone(state.accounts));
    if (/^\/api\/accounts\/[^/]+\/folders$/.test(pathname)) return ok(folderRows(state, pathname.split('/')[3]));
    if (/^\/api\/accounts\/[^/]+\/aliases$/.test(pathname)) return ok([]);
    if (pathname === '/api/mail/unread-counts') return ok(counts(state));
    if (pathname === '/api/mail/messages') return ok(listMessages(state, query));
    if (pathname === '/api/search') return ok(listMessages(state, query, true));
    if (pathname === '/api/search/contacts') return ok([]);
    if (pathname === '/api/mail/category-counts') {
      const rows = state.messages.filter(m => m.folder === 'INBOX' && (!query.get('accountId') || m.account_id === query.get('accountId')));
      const totals = {}, unread = {};
      for (const m of rows) { totals[m.category] = (totals[m.category] || 0) + 1; if (!m.is_read) unread[m.category] = (unread[m.category] || 0) + 1; }
      return ok({ totals, counts: unread });
    }
    if (pathname === '/api/mail/thread') return ok({ messages: state.messages.filter(m => m.thread_id === query.get('id') && (!query.get('accountId') || m.account_id === query.get('accountId'))) });
    if (pathname === '/api/mail/resolve-message') {
      const message = state.messages.find(m => (m.id === query.get('ref') || m.message_id === query.get('ref')) && (!query.get('accountId') || m.account_id === query.get('accountId')));
      return message ? ok(structuredClone(message)) : fail(404, 'Message not found');
    }
    const match = pathname.match(/^\/api\/mail\/messages\/(fixture-message-\d+)(?:\/(body|reply-draft|bcc|headers))?$/);
    if (match) {
      const m = state.messages.find(m => m.id === match[1]);
      if (!m) return fail(404, 'Fictional message not found');
      return ok(match[2] === 'body' ? messageBody(m) : match[2] === 'reply-draft' ? { exists: false, draft: null } : match[2] === 'bcc' ? { bcc: [] } : match[2] === 'headers' ? { headers: `From: ${m.from_email}\r\nSubject: ${m.subject}\r\nMessage-ID: ${m.message_id}` } : structuredClone(m));
    }
    if (pathname === '/api/todoist/status') return ok({ connected: false });
    if (pathname === '/api/update') return ok({ updateAvailable: false, currentVersion: '4.3.1' });
    if (pathname === '/api/mail/scheduled') return ok({ messages: [], total: 0 });
    if (pathname === '/api/contacts') return ok({ contacts: [], total: 0 });
    if (['/api/integrations', '/api/rules', '/api/categories/sources', '/api/block-list'].includes(pathname)) return ok([]);
    if (pathname === '/api/ai/status') return ok({ enabled: false, available: false });
    if (pathname === '/api/plugins') return ok([{ id: 'gtd', name: 'Getting Things Done', tier: 1, activated: false }]);
  }
  if (method === 'PATCH' && pathname === '/api/auth/preferences') { Object.assign(state.preferences, body); return ok(structuredClone(state.preferences)); }
  if (method === 'POST' && pathname === '/api/mail/reply-drafts/indicators') return ok({ indicators: {} });
  if (method === 'POST' && ['/api/mail/sync-folder', '/api/mail/sync-folders', '/api/mail/sync'].includes(pathname)) return ok({ success: true, fixture: true });
  const copy = pathname.match(/^\/api\/mail\/messages\/(fixture-message-\d+)\/copy$/);
  if (method === 'POST' && copy) {
    const source = state.messages.find(m => m.id === copy[1]);
    if (!source || body.folder !== 'Projects' || source.folder === body.folder) return fail(400, 'Invalid fictional copy target');
    const next = Math.max(...state.messages.map(m => m.uid)) + 1;
    state.messages.push({ ...structuredClone(source), id: `fixture-message-${next}`, uid: next, folder: body.folder });
    state.mutations.push({ method, pathname, body: structuredClone(body) });
    return ok({ ok: true, uid: next });
  }
  const bulk = pathname.match(/^\/api\/mail\/messages\/bulk-(read|star|archive|move|delete)$/);
  const single = pathname.match(/^\/api\/mail\/messages\/(fixture-message-\d+)\/(star|snooze|unsnooze)$/);
  if ((method === 'POST' && bulk) || (['POST', 'PATCH'].includes(method) && single)) {
    const rows = state.messages.filter(m => bulk ? (body.ids || []).includes(m.id) : m.id === single[1]);
    const op = bulk?.[1] || single[2];
    const updated = rows.filter(m => op === 'read' ? !!m.is_read !== !!body.read : op === 'star' ? !!m.is_starred !== !!body.starred : true).map(m => m.id);
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
    const ids = rows.map(m => m.id);
    return ok(op === 'archive' ? { ok: true, archived: ids, noArchiveFolder: [] }
      : op === 'move' ? { ok: true, moved: ids }
        : op === 'delete' ? { ok: true, deleted: ids }
          : ['read', 'star'].includes(op) && bulk ? { ok: true, updated }
            : { ok: true, ...(op === 'star' ? { is_starred: body.starred } : {}) });
  }
  // Draft capture is in-memory only; this fixture does not qualify native persistence/reload.
  if (method === 'POST' && pathname === '/api/mail/draft') { state.drafts.push(structuredClone(body)); return ok({ uid: 1000 + state.drafts.length, folder: 'Drafts', fixture: true }); }
  if (method === 'DELETE' && pathname.startsWith('/api/mail/draft/')) return ok({ success: true, fixture: true });
  return fail(501, `Unsupported native fixture route: ${method} ${pathname}`);
}

export async function createFixtureServer({ dist = path.join(ROOT, 'frontend/dist'), state = createFixtureState() } = {}) {
  const root = await realpath(dist);
  const server = http.createServer(async (req, res) => {
    const hostname = (req.headers.host || '').split(':')[0];
    if (!['127.0.0.1', 'localhost'].includes(hostname)) { res.writeHead(403); res.end('Loopback host only'); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-MailFlow-Fixture', 'native-layout-fictional-only');
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
