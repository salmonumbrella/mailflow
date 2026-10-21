// Plain text from an email's HTML, for a model to read. It is not a renderer: it keeps the words,
// the line structure, link targets and image alt text, and drops markup, styles and code. One
// linear scan with indexOf, so a hostile message cannot make it backtrack.

// Raw-text elements: their content runs to the closing tag, or to the end when there is none.
const RAW_TEXT = new Set(['script', 'style']);
// Content dropped only when the element is closed, so a stray opening tag cannot hide the rest.
const DROPPED = new Set(['head', 'title', 'noscript', 'template', 'svg', 'math', 'object', 'iframe', 'select', 'textarea']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'caption', 'center', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header', 'main', 'nav', 'ol', 'section',
  'summary', 'table', 'tbody', 'tfoot', 'thead', 'tr', 'ul',
]);
const PARAGRAPH = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const ZERO_WIDTH = /[­͏᠎​-‍⁠﻿]/g;
const MAX_LINK_LENGTH = 300;
// How much of a link's text is read back to see whether it already shows the address. Past this
// the address is shown anyway: rereading more for each closing tag would let nested links make
// the conversion quadratic.
const MAX_LINK_TEXT = 2000;

const NAMED = Object.create(null);
'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'
  .split(' ').forEach((name, i) => { NAMED[name] = String.fromCharCode(160 + i); });
Object.assign(NAMED, {
  quot: '"', amp: '&', apos: "'", lt: '<', gt: '>', OElig: 'Œ', oelig: 'œ', Scaron: 'Š',
  scaron: 'š', Yuml: 'Ÿ', fnof: 'ƒ', circ: 'ˆ', tilde: '˜', ensp: ' ',
  emsp: ' ', thinsp: ' ', zwnj: '‌', zwj: '‍', lrm: '‎', rlm: '‏',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“',
  rdquo: '”', bdquo: '„', dagger: '†', Dagger: '‡', bull: '•', hellip: '…',
  permil: '‰', prime: '′', Prime: '″', lsaquo: '‹', rsaquo: '›', oline: '‾',
  frasl: '⁄', euro: '€', trade: '™', larr: '←', uarr: '↑', rarr: '→',
  darr: '↓', harr: '↔', hearts: '♥', check: '✓',
});
// Entities a browser still decodes without the semicolon, in text (never in attributes).
const LEGACY = new Set(['amp', 'lt', 'gt', 'quot', 'nbsp', 'copy', 'reg']);
const UPPER_ALIASES = new Set(['AMP', 'LT', 'GT', 'QUOT', 'COPY', 'REG']);
// Browsers read &#128;–&#159; as windows-1252, and senders rely on it for quotes and dashes.
const WINDOWS_1252 = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
  0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}))(;?)/g;

function fromCodePoint(cp) {
  if (WINDOWS_1252[cp]) return String.fromCodePoint(WINDOWS_1252[cp]);
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
  if ((cp < 0x20 && cp !== 9 && cp !== 10 && cp !== 13) || (cp >= 0x7f && cp < 0xa0)) return '';
  return String.fromCodePoint(cp);
}

export function decodeEntities(text, { attribute = false } = {}) {
  if (typeof text !== 'string' || !text.includes('&')) return text || '';
  return text.replace(ENTITY, (match, dec, hex, name, semicolon) => {
    if (dec !== undefined || hex !== undefined) {
      if (attribute && !semicolon) return match;
      return fromCodePoint(dec !== undefined ? Number(dec) : parseInt(hex, 16));
    }
    const value = NAMED[name] ?? (UPPER_ALIASES.has(name) ? NAMED[name.toLowerCase()] : undefined);
    if (value === undefined) return match;
    if (!semicolon && (attribute || !LEGACY.has(name.toLowerCase()))) return match;
    return value;
  });
}

function isSpaceCode(code) {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

function isLetterCode(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isNameCode(code) {
  return isLetterCode(code) || (code >= 48 && code <= 57) || code === 45 || code === 58;
}

// Reads a tag's attributes up to its '>' (quotes respected) and keeps only the wanted ones.
function scanTag(source, start, wanted) {
  const n = source.length;
  const attrs = wanted ? {} : null;
  let i = start;
  for (;;) {
    while (i < n && (isSpaceCode(source.charCodeAt(i)) || source[i] === '/')) i++;
    if (i >= n) return { end: n, attrs };
    if (source[i] === '>') return { end: i + 1, attrs };
    const nameStart = i;
    while (i < n && !isSpaceCode(source.charCodeAt(i)) && source[i] !== '=' && source[i] !== '>' && source[i] !== '/') i++;
    const attrName = source.slice(nameStart, i).toLowerCase();
    let j = i;
    while (j < n && isSpaceCode(source.charCodeAt(j))) j++;
    let value = null;
    if (source[j] === '=') {
      j++;
      while (j < n && isSpaceCode(source.charCodeAt(j))) j++;
      const quote = source[j];
      if (quote === '"' || quote === "'") {
        const close = source.indexOf(quote, j + 1);
        const stop = close === -1 ? n : close;
        if (wanted?.has(attrName)) value = source.slice(j + 1, stop);
        j = close === -1 ? n : close + 1;
      } else {
        const valueStart = j;
        while (j < n && !isSpaceCode(source.charCodeAt(j)) && source[j] !== '>') j++;
        if (wanted?.has(attrName)) value = source.slice(valueStart, j);
      }
      i = j;
    }
    if (value !== null && !(attrName in attrs)) attrs[attrName] = decodeEntities(value, { attribute: true });
    if (i === nameStart) i++;
  }
}

function closeTagEnd(source, from) {
  const end = source.indexOf('>', from);
  return end === -1 ? source.length : end + 1;
}

function linkHost(href) {
  try {
    return new URL(href).hostname || 'a long address';
  } catch {
    return 'a long address';
  }
}

class Output {
  constructor(limit) {
    this.parts = [];
    this.length = 0;
    this.limit = limit;
    this.full = false;
    this.lastChar = '\n';
    this.beforeLast = '\n';
    this.quoteDepth = 0;
    this.pre = 0;
  }

  push(value) {
    if (!value) return;
    this.parts.push(value);
    this.length += value.length;
    this.beforeLast = value.length > 1 ? value[value.length - 2] : this.lastChar;
    this.lastChar = value[value.length - 1];
    if (this.length > this.limit) this.full = true;
  }

  // A block starts on a new line; several blocks in a row do not stack up blank lines.
  breakLine() {
    if (this.length && this.lastChar !== '\n') this.push('\n');
  }

  blankLine() {
    if (!this.length) return;
    if (this.lastChar !== '\n') this.push('\n\n');
    else if (this.beforeLast !== '\n') this.push('\n');
  }

  text(raw) {
    let value = decodeEntities(raw).replace(ZERO_WIDTH, '');
    value = this.pre ? value.replace(/\r\n?/g, '\n') : value.replace(/\s+/g, ' ');
    if (!value) return;
    if (this.lastChar === '\n') {
      if (!value.trim()) return;
      if (this.quoteDepth) this.push('> '.repeat(this.quoteDepth));
    }
    this.push(value);
  }

  newline(count = 1) {
    this.push('\n'.repeat(count));
  }

  since(partIndex) {
    return this.parts.slice(partIndex).join('');
  }
}

/**
 * @param {string} html
 * @param {{ maxChars?: number }} [options] stop converting soon after this much text
 * @returns {{ text: string, complete: boolean }} complete is false when conversion stopped early
 */
export function htmlToText(html, { maxChars = Infinity } = {}) {
  const source = typeof html === 'string' ? html : '';
  const lower = source.toLowerCase();
  const out = new Output(maxChars === Infinity ? Infinity : maxChars + 1000);
  const anchors = [];
  // Elements whose closing tag is known to be missing from here on. The scan only moves forward,
  // so once a search finds none it never will, and searching again for every later opening tag
  // of that name would make an unclosed one quadratic.
  const unclosed = new Set();
  const n = source.length;
  let i = 0;

  const open = (name, attrs) => {
    if (name === 'br') out.newline();
    else if (name === 'hr') { out.breakLine(); out.push('---'); out.newline(); }
    else if (name === 'li') { out.breakLine(); out.text('- '); }
    else if (PARAGRAPH.has(name)) out.blankLine();
    else if (name === 'blockquote') { out.breakLine(); out.quoteDepth++; }
    else if (name === 'pre') { out.breakLine(); out.pre++; }
    else if (name === 'a') anchors.push({ href: attrs?.href, partIndex: out.parts.length, length: out.length });
    else if (name === 'img') {
      const alt = (attrs?.alt || '').replace(/\s+/g, ' ').trim();
      if (alt) out.text(`[image: ${alt.slice(0, 100)}]`);
    } else if (BLOCK.has(name)) out.breakLine();
  };

  const close = (name) => {
    if (PARAGRAPH.has(name)) out.blankLine();
    else if (name === 'blockquote') { out.quoteDepth = Math.max(0, out.quoteDepth - 1); out.breakLine(); }
    else if (name === 'pre') { out.pre = Math.max(0, out.pre - 1); out.breakLine(); }
    else if (name === 'td' || name === 'th') out.push(' ');
    else if (name === 'a') {
      const anchor = anchors.pop();
      const href = anchor?.href?.trim();
      if (!href || !/^(https?:|mailto:)/i.test(href)) return;
      const inside = out.length - anchor.length;
      if (!inside) return;
      if (inside <= MAX_LINK_TEXT) {
        const visible = out.since(anchor.partIndex).replace(/\s+/g, ' ').trim();
        if (!visible) return;
        const target = href.replace(/^mailto:/i, '').split('?')[0];
        if (visible.toLowerCase().includes(target.toLowerCase())) return;
      }
      out.push(href.length > MAX_LINK_LENGTH ? ` (link to ${linkHost(href)})` : ` (${href})`);
    } else if (BLOCK.has(name)) out.breakLine();
  };

  while (i < n && !out.full) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      out.text(source.slice(i));
      break;
    }
    if (lt > i) out.text(source.slice(i, lt));
    i = lt;
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    const next = source.charCodeAt(i + 1);
    if (next === 33 || next === 63) { // <! and <?
      i = closeTagEnd(source, i + 2);
      continue;
    }
    const closing = next === 47; // </
    const nameStart = closing ? i + 2 : i + 1;
    if (!isLetterCode(source.charCodeAt(nameStart))) {
      out.text('<');
      i += 1;
      continue;
    }
    let nameEnd = nameStart;
    while (nameEnd < n && isNameCode(source.charCodeAt(nameEnd))) nameEnd++;
    const name = lower.slice(nameStart, nameEnd);
    const wanted = closing ? null : name === 'a' ? new Set(['href']) : name === 'img' ? new Set(['alt']) : null;
    const { end, attrs } = scanTag(source, nameEnd, wanted);
    i = end;
    if (closing) {
      close(name);
      continue;
    }
    open(name, attrs);
    if (RAW_TEXT.has(name) || DROPPED.has(name)) {
      const closeAt = unclosed.has(name) ? -1 : lower.indexOf(`</${name}`, i);
      if (closeAt !== -1) i = closeTagEnd(source, closeAt + name.length + 2);
      else if (RAW_TEXT.has(name)) i = n;
      else unclosed.add(name);
    }
  }

  const text = out.parts.join('')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, complete: !out.full };
}
