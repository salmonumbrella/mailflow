import { expect, it, vi } from 'vitest';
vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
import { normalizeScopes } from './apiTokens.js';
import { matchApiTokenRoute } from './apiTokenAllowlist.js';

const id = '11111111-1111-4111-8111-111111111111';
const read = `/api/accounts/${id}/sender-identities`;
const write = `/api/accounts/${id}/masked-emails`;
it('accepts separate identity grants without inferring one from the other or broadening old tokens', () => {
  expect(normalizeScopes(['identity:write'])).toEqual(['identity:write']);
  expect(normalizeScopes(['identity:read'])).toEqual(['identity:read']);
  expect(normalizeScopes(['read', 'organize', 'draft'])).toEqual(['read', 'organize', 'draft']);
  expect(normalizeScopes(['identity:admin'])).toBeNull();
  expect(normalizeScopes(['identity:write', 'identity:write'])).toBeNull();
  expect(matchApiTokenRoute('GET', read)?.scope).toBe('identity:read');
  expect(matchApiTokenRoute('POST', write)?.scope).toBe('identity:write');
});
it('keeps the provider route allowlist anchored, method-specific and HEAD-free', () => {
  for (const [method, path] of [['HEAD', read], ['POST', read], ['GET', write], ['PUT', write],
    ['GET', `${read}/`], ['GET', read.toUpperCase()], ['GET', read.replace('sender', '%73ender')],
    ['POST', write.replace('/accounts/', '//accounts/')], ['POST', `${write}/extra`],
    ['POST', '/api/accounts/not-a-uuid/masked-emails']]) expect(matchApiTokenRoute(method, path)).toBeNull();
});
