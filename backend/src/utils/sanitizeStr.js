// PostgreSQL UTF-8 text and jsonb reject NUL, including NUL inside mail headers.
export function sanitizeStr(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/\0/g, '');
}
