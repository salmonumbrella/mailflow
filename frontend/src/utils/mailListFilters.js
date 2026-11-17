import { topOpenMessageWindow } from './messageHotkeys.js';
import { SCHEDULED_VIEW } from './scheduledCompose.js';

export function canFilterMailList(state) {
  return Boolean(state.user && !state.isLocked && state.layout === 'superhuman'
    && !state.selectedMessageId && !topOpenMessageWindow(state) && !state.composing && !state.showContacts && !state.showAdmin
    && !state.activeGtdTab && state.selectedFolder !== 'Snoozed' && state.selectedFolder !== SCHEDULED_VIEW);
}

// A native supported query, not a client-side filter of the currently loaded page.
// Quoted subject/from terms remain untouched; only a standalone star operator toggles.
const searchTerms = query => query.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
const isStarred = term => /^is:(?:starred|"starred")$/i.test(term);
export const hasStarredSearch = (query = '') => searchTerms(query).some(isStarred);
export function toggleStarredSearch(query = '') {
  const terms = searchTerms(query);
  return terms.some(isStarred) ? terms.filter(term => !isStarred(term)).join(' ') : [...terms.filter(term => !/^-is:(?:starred|"starred")$/i.test(term)), 'is:starred'].join(' ');
}
