import { isIP } from 'node:net';

export const OPEN_ACTIVITY_PATH = '/api/open-activity/pixel';
export const OPEN_ACTIVITY_RETENTION_DAYS = 30;
export const OPEN_ACTIVITY_MAX_LOADS = 1000;
export const OPEN_ACTIVITY_INTERVAL_MS = 60_000;
export const OPEN_ACTIVITY_NOTICE = 'Image loads are not proof that a person read your email. Proxies, prefetching, forwarded messages and your own Sent view can cause loads; image blocking can hide them. No recipient, IP address, location or device is identified. Counts are rate-limited and expire after 30 days.';
export const OPEN_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const OPEN_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Never derive this from a request Host header. A single public HTTPS origin is required.
export function openActivityOrigin(value = process.env.APP_URL) {
  if (typeof value !== 'string' || value.length > 2048 || value !== value.trim() || !/^https:\/\/[^/?#\s\\]+\/?$/.test(value)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname;
    if (host.length > 253) return null;
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || url.pathname !== '/' || url.search || url.hash || isIP(host) || host.startsWith('[')
      || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host) || !host.includes('.')
      || host.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))
      || /(?:^|\.)(?:localhost|local|internal|lan|home|invalid|test)$/i.test(host)) return null;
    return url.origin;
  } catch { return null; }
}

export class OpenActivityError extends Error {
  constructor(status, message) { super(message); this.name = 'OpenActivityError'; this.status = status; }
}

export function requireOpenActivityAvailable(input, identity) {
  if (input.trackOpens !== true) return;
  if (identity.plaintextEmail) throw new OpenActivityError(400, 'Open activity requires HTML email. Turn it off to send plain text.');
  if (!openActivityOrigin()) throw new OpenActivityError(409, 'Open activity needs a configured public HTTPS APP_URL. Turn it off to send without tracking.');
}
