// Raw headers are display data, never evidence of delivery authentication or transport security.
function displayHeaders(raw) {
  const fields = new Map();
  let current = null;
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (!line) break;
    if (/^[ \t]/.test(line) && current) {
      current.value += ` ${line.trim()}`;
      continue;
    }
    const match = /^([^\s:]+):\s*(.*)$/.exec(line);
    current = match ? { value: match[2] } : null;
    if (current) {
      const key = match[1].toLowerCase();
      if (!fields.has(key)) fields.set(key, []);
      fields.get(key).push(current);
    }
  }
  return key => (fields.get(key) || []).map(field => field.value).join(', ');
}

function addresses(value) {
  try {
    const list = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(list) ? list.map(entry => {
      if (typeof entry === 'string') return entry;
      if (!entry?.email) return '';
      return entry.name ? `${entry.name} <${entry.email}>` : entry.email;
    }).filter(Boolean).join(', ') : '';
  } catch { return ''; }
}

export function gmailMessageDetails(message, body, result) {
  const header = displayHeaders(result?.headers);
  return {
    from: message.from_email ? (message.from_name ? `${message.from_name} <${message.from_email}>` : message.from_email) : header('from'),
    to: addresses(message.to_addresses) || header('to'),
    cc: addresses(message.cc_addresses) || header('cc'),
    // The body endpoint only provides Bcc where it is available to this mailbox's owner.
    bcc: addresses(body?.bccAddresses),
    date: message.date || header('date'),
    subject: (result?.subject && result.subject !== '(no subject)' ? result.subject : message.subject) || header('subject'),
  };
}
