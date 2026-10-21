import net from 'node:net';

// MailFlow's own format: 'mfat_' plus 32 random bytes in base64url.
export const TOKEN_PATTERN = /^mfat_[A-Za-z0-9_-]{43}$/;
export const DEFAULT_TIMEOUT_MS = 60000;
export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const DEFAULT_HTTP_PORT = 8787;

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function isTokenFormat(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

// The most of a token that may ever be shown.
export function maskToken(token) {
  return typeof token === 'string' && token.length > 9 ? `mfat_…${token.slice(-4)}` : 'mfat_…';
}

const LOCAL_ADDRESSES = new net.BlockList();
LOCAL_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4');
LOCAL_ADDRESSES.addSubnet('10.0.0.0', 8, 'ipv4');
LOCAL_ADDRESSES.addSubnet('172.16.0.0', 12, 'ipv4');
LOCAL_ADDRESSES.addSubnet('192.168.0.0', 16, 'ipv4');
LOCAL_ADDRESSES.addSubnet('169.254.0.0', 16, 'ipv4');
LOCAL_ADDRESSES.addAddress('::1', 'ipv6');
LOCAL_ADDRESSES.addSubnet('fc00::', 7, 'ipv6');
LOCAL_ADDRESSES.addSubnet('fe80::', 10, 'ipv6');

// Loopback, RFC 1918, unique-local, link-local, or a single-label name such as a container's
// service name (`backend`). Plain HTTP to anything else would carry the token across networks.
export function isLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  const family = net.isIP(host);
  if (family === 4) return LOCAL_ADDRESSES.check(host, 'ipv4');
  if (family === 6) return LOCAL_ADDRESSES.check(host, 'ipv6');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?$/.test(host);
}

export function parseMailflowUrl(raw, { allowInsecureHttp = false } = {}) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) throw new ConfigError('MAILFLOW_URL is required, for example https://mail.example.com');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigError(`MAILFLOW_URL is not a valid URL: ${text}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError('MAILFLOW_URL must start with https:// (or http:// on a private network)');
  }
  if (url.username || url.password) {
    throw new ConfigError('MAILFLOW_URL must not contain a user name or password');
  }
  if (text.includes('?') || text.includes('#')) {
    throw new ConfigError('MAILFLOW_URL must not have a query string or a fragment');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (/\/api$/i.test(path)) {
    throw new ConfigError("MAILFLOW_URL is MailFlow's own address, without /api (for example https://mail.example.com)");
  }
  const insecure = url.protocol === 'http:' && !isLocalHost(url.hostname);
  if (insecure && !allowInsecureHttp) {
    throw new ConfigError(
      `MAILFLOW_URL uses http:// to ${url.hostname}, which is not a loopback, private or container address, ` +
      'so the API token would cross the network unencrypted. Use https://, or set MAILFLOW_ALLOW_INSECURE_HTTP=1 to allow it anyway.',
    );
  }
  return { baseUrl: `${url.protocol}//${url.host}${path}`, origin: url.origin, insecure };
}

function wholeNumber(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const text = String(raw).trim();
  const value = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

// Host names only: a port in an entry is ignored, as the Host check ignores ports.
export function parseHostList(raw) {
  if (raw === undefined || raw === null) return [];
  const hosts = [];
  for (const part of String(raw).split(',')) {
    const entry = part.trim().toLowerCase();
    if (!entry) continue;
    let host = entry;
    if (entry.includes('://')) {
      try {
        host = new URL(entry).hostname;
      } catch {
        throw new ConfigError(`MCP_ALLOWED_HOSTS has an entry that is not a host name: ${part.trim()}`);
      }
    }
    host = hostnameOf(host);
    if (!host || /[\s/@]/.test(host)) {
      throw new ConfigError(`MCP_ALLOWED_HOSTS has an entry that is not a host name: ${part.trim()}`);
    }
    if (!hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

// The host name part of a Host header value, lower-cased, without port or IPv6 brackets.
export function hostnameOf(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    return end === -1 ? '' : text.slice(1, end);
  }
  const colons = text.split(':').length - 1;
  if (colons === 1) return text.slice(0, text.indexOf(':'));
  return text;
}

export function parseOriginList(raw) {
  if (raw === undefined || raw === null) return [];
  const origins = [];
  for (const part of String(raw).split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    let origin;
    try {
      const url = new URL(entry);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme');
      origin = url.origin;
    } catch {
      throw new ConfigError(`MCP_ALLOWED_ORIGINS has an entry that is not an origin such as https://claude.ai: ${entry}`);
    }
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

export function loadConfig(mode, env = process.env) {
  if (mode !== 'stdio' && mode !== 'http') throw new ConfigError(`Unknown mode ${mode}`);
  const warnings = [];
  const allowInsecureHttp = String(env.MAILFLOW_ALLOW_INSECURE_HTTP ?? '').trim() === '1';
  const { baseUrl, origin, insecure } = parseMailflowUrl(env.MAILFLOW_URL, { allowInsecureHttp });
  if (insecure) {
    warnings.push(`MAILFLOW_URL uses unencrypted http:// to a public address (${origin}); allowed by MAILFLOW_ALLOW_INSECURE_HTTP=1`);
  }
  const timeoutMs = wholeNumber(env, 'MAILFLOW_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 1000, 600000);
  const token = String(env.MAILFLOW_TOKEN ?? '').trim();

  if (mode === 'stdio') {
    if (!token) {
      throw new ConfigError('MAILFLOW_TOKEN is required: create an API token in MailFlow under Settings → Security → API tokens');
    }
    if (!isTokenFormat(token)) {
      throw new ConfigError('MAILFLOW_TOKEN is not a MailFlow API token (expected mfat_ followed by 43 letters, digits, - or _)');
    }
    return { mode, mailflowUrl: baseUrl, origin, token, timeoutMs, warnings };
  }

  if (token) {
    throw new ConfigError(
      'MAILFLOW_TOKEN must not be set in http mode: each caller sends its own token, which is passed through to MailFlow, ' +
      'and the server must hold none of its own',
    );
  }
  const host = String(env.MCP_HTTP_HOST ?? '').trim() || DEFAULT_HTTP_HOST;
  const port = wholeNumber(env, 'MCP_HTTP_PORT', DEFAULT_HTTP_PORT, 0, 65535);
  const allowedHosts = parseHostList(env.MCP_ALLOWED_HOSTS);
  const allowedOrigins = parseOriginList(env.MCP_ALLOWED_ORIGINS);
  const trustProxyHops = wholeNumber(env, 'MCP_TRUST_PROXY_HOPS', 0, 0, 10);
  if (!allowedHosts.length) {
    warnings.push('MCP_ALLOWED_HOSTS is not set, so /mcp accepts any Host header; set it to the name clients use, such as mcp.example.com');
  }
  return {
    mode,
    mailflowUrl: baseUrl,
    origin,
    timeoutMs,
    warnings,
    http: { host, port, allowedHosts, allowedOrigins, trustProxyHops },
  };
}
