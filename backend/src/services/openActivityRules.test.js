import { describe, expect, it, afterEach, vi } from 'vitest';
import { openActivityOrigin, requireOpenActivityAvailable } from './openActivityRules.js';

afterEach(() => vi.unstubAllEnvs());
describe('open activity origin and consent', () => {
  it('only accepts an HTTPS origin with a public-form DNS hostname', () => {
    expect(openActivityOrigin('https://mail.example')).toBe('https://mail.example');
    expect(openActivityOrigin('https://mail.example:443/')).toBe('https://mail.example');
    for (const value of [null, '', ' https://mail.example', 'http://mail.example', 'https://mail.example/path', 'https://mail.example?q=x', 'https://mail.example#x', 'https://u:p@mail.example', 'https://mail.example:8443', 'https://localhost', 'https://app.local', 'https://app.internal', 'https://app.invalid', 'https://127.0.0.1', 'https://2130706433', 'https://0x7f000001', 'https://[::1]', 'https://mail..example', 'https://-mail.example', 'https://mail.example.', 'https:mail.example', 'https://mail.example\n', 'https:\\mail.example']) expect(openActivityOrigin(value), String(value)).toBeNull();
  });
  it('does not check setup for default-off sends and refuses enabled plain-text or missing setup', () => {
    vi.stubEnv('APP_URL', 'http://localhost');
    expect(() => requireOpenActivityAvailable({}, { plaintextEmail: true })).not.toThrow();
    expect(() => requireOpenActivityAvailable({ trackOpens: false }, {})).not.toThrow();
    expect(() => requireOpenActivityAvailable({ trackOpens: true }, {})).toThrow('public HTTPS');
    vi.stubEnv('APP_URL', 'https://mail.example');
    expect(() => requireOpenActivityAvailable({ trackOpens: true }, { plaintextEmail: true })).toThrow('HTML email');
    expect(() => requireOpenActivityAvailable({ trackOpens: true }, { plaintextEmail: false })).not.toThrow();
  });
});
