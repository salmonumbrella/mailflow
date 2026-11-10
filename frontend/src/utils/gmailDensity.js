export const GMAIL_DENSITIES = Object.freeze(['default', 'comfortable', 'compact']);

export function isGmailDensity(value) {
  return GMAIL_DENSITIES.includes(value);
}

export function normalizeGmailDensity(value) {
  return isGmailDensity(value) ? value : 'default';
}

export function applyGmailDensity(value) {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-gmail-density', normalizeGmailDensity(value));
  }
}
