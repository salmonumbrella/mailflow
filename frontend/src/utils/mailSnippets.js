export const SNIPPET_TITLE_LIMIT = 120;
export const SNIPPET_BODY_LIMIT = 20000;
export const SNIPPET_SUBJECT_LIMIT = 200;

export function isSnippetShortcut(event) {
  return event?.key === ';' && !event.repeat && !event.isComposing && !event.nativeEvent?.isComposing && event.keyCode !== 229
    && !event.shiftKey && !event.altKey && (!!event.ctrlKey !== !!event.metaKey);
}

export function insertSnippetText(body, snippet, cursor) {
  const at = Math.max(0, Math.min(body.length, Number.isInteger(cursor) ? cursor : body.length));
  return { text: body.slice(0, at) + snippet + body.slice(at), cursor: at + snippet.length };
}

// Plain text never passes through an HTML parser, including when it looks like markup.
export function snippetContent(body) {
  return body.replace(/\r\n?/g, '\n').split('\n').flatMap((line, index) => [
    ...(index ? [{ type: 'hardBreak' }] : []),
    ...(line ? [{ type: 'text', text: line }] : []),
  ]);
}


export function snippetDraft(snippet, plaintextEmail) {
  const body = plaintextEmail ? snippet.body : `<p>${snippet.body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\r\n?/g, '\n').replace(/\n/g, '<br>')}</p>`;
  return { subject: snippet.subject || '', body, bodyIsHtml: !plaintextEmail };
}

export async function openSnippetDraft(store, snippet, isCurrent = () => true) {
  const before = store.getState();
  if (!before.user?.id || !isCurrent()) return false;
  let invalidated = false;
  const current = () => {
    const state = store.getState();
    return !invalidated && isCurrent() && state.user?.id === before.user.id
      && state.selectedAccountId === before.selectedAccountId && state.composeSession === before.composeSession
      && state.composing === before.composing && state.plaintextEmail === before.plaintextEmail
      && (!state.selectedAccountId || state.accounts.some(account => account.id === state.selectedAccountId && account.enabled !== false));
  };
  const unsubscribe = store.subscribe(() => { if (!current()) invalidated = true; });
  try {
    if (before.composing) {
      if (!before.prepareComposeSwitch || !await before.prepareComposeSwitch()) return false;
      if (!current() || store.getState().prepareComposeSwitch !== before.prepareComposeSwitch) return false;
    }
    if (!current()) return false;
    return store.getState().openCompose(snippetDraft(snippet, before.plaintextEmail), { preparedSession: before.composeSession });
  } finally { unsubscribe(); }
}
