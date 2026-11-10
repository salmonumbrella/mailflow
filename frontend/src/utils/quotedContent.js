const QUOTE = 'blockquote, div.gmail_quote, div.gmail_extra';

// Operates only on the renderer's existing sanitized DOM. No re-parsing, URL changes,
// or HTML inserted into the app document; source bodies remain available for forwarding/printing.
export function installQuotedContent(root, { label = 'Quoted content', onToggle } = {}) {
  if (!root) return () => {};
  const quotes = [...root.querySelectorAll(QUOTE)].filter(node => !node.parentElement?.closest(`${QUOTE}, details`));
  if (!quotes.length) return () => {};
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  let hasReply = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent.trim() && !node.parentElement?.closest(`${QUOTE}, style, script, template`)) { hasReply = true; break; }
  }
  // A quoted-only message has no new portion to show. Hiding it makes an apparently empty mail.
  if (!hasReply) return () => {};
  const inserted = quotes.map(node => {
    const details = root.ownerDocument.createElement('details');
    const summary = root.ownerDocument.createElement('summary');
    summary.textContent = label;
    summary.style.cssText = 'cursor:pointer; font:inherit; font-size:12px; padding:4px 0;';
    details.append(summary);
    node.replaceWith(details);
    details.append(node);
    if (onToggle) details.addEventListener('toggle', onToggle);
    return { details, node };
  });
  return () => inserted.forEach(({ details, node }) => {
    if (onToggle) details.removeEventListener('toggle', onToggle);
    details.replaceWith(node);
  });
}

export function splitQuotedText(text) {
  const lines = String(text).match(/[^\n]*\n|[^\n]+$/g) || [];
  if (!lines.some(line => line.trim() && !/^\s*>/.test(line))) return [{ text, quoted: false }];
  const parts = [];
  for (const line of lines) {
    const quoted = /^\s*>/.test(line);
    const previous = parts.at(-1);
    if (previous?.quoted === quoted) previous.text += line;
    else parts.push({ text: line, quoted });
  }
  return parts.length ? parts : [{ text, quoted: false }];
}
