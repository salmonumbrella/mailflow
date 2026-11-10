import { buildGtdDisplaySections } from './gtd.js';

// Klinger-style multiple inboxes are a presentation of the plugin's existing
// labels, not Gmail special-star state. Keep Watch and Delegated independent so
// completing one never silently removes the other. Someday remains accessible.
export const GMAIL_GTD_SECTION_ORDER = ['todo', 'watch', 'delegated', 'reference', 'someday'];
export const GMAIL_GTD_PAGE_SIZE = 9;
export const GMAIL_GTD_SYMBOLS = { todo: '!', watch: '?', delegated: '»', reference: '★', someday: '◷' };

export function buildGmailGtdSections(sections) {
  return GMAIL_GTD_SECTION_ORDER.map(key => {
    const section = sections?.[key];
    const threads = Array.isArray(section?.threads) ? section.threads : [];
    return {
      key, threads,
      total: Math.max(threads.length, Number(section?.total) || 0),
      unread: Math.max(0, Number(section?.unread) || 0),
    };
  });
}

// Both presentations can be mounted while switching layout. Retain the merged
// Waiting target as well as the two individual label targets for keyboard triage.
export function buildGtdActionSections(sections) {
  return [...buildGtdDisplaySections(sections), ...buildGmailGtdSections(sections).filter(s => s.key === 'watch' || s.key === 'delegated')];
}

export function getGmailGtdPage(section, requestedPage = 0) {
  const threads = Array.isArray(section?.threads) ? section.threads : [];
  const pageCount = Math.max(1, Math.ceil(threads.length / GMAIL_GTD_PAGE_SIZE));
  const page = Math.min(pageCount - 1, Math.max(0, Math.trunc(Number(requestedPage) || 0)));
  const start = page * GMAIL_GTD_PAGE_SIZE;
  const rows = threads.slice(start, start + GMAIL_GTD_PAGE_SIZE);
  const total = Math.max(threads.length, Number(section?.total) || 0);
  return {
    page, pageCount, rows, total,
    first: rows.length ? start + 1 : 0,
    last: start + rows.length,
    available: threads.length,
    bounded: total > threads.length,
  };
}
