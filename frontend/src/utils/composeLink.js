export function normalizeComposeLink(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return null;
    if (url.protocol === 'mailto:' && !url.pathname.includes('@')) return null;
    return url.href;
  } catch {
    return null;
  }
}
