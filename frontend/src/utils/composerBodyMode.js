import DOMPurify from 'dompurify';

// textContent decodes entities, but needs explicit block boundaries to preserve paragraphs.
export function composerHtmlToText(html) {
  const root = document.createElement('div');
  root.innerHTML = DOMPurify.sanitize(html || '', { FORBID_TAGS: ['img', 'style'] });
  root.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  root.querySelectorAll('p, div, li, blockquote, tr, h1, h2, h3, h4, h5, h6').forEach(node => node.append('\n'));
  return (root.textContent || '').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '');
}

export function composerTextToHtml(text) {
  const escaped = String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<p>${escaped.replace(/\r\n?/g, '\n').replace(/\n/g, '<br>')}</p>`;
}
