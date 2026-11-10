import { describe, it, expect, vi } from 'vitest';

// gtd/index.js imports routes/gtd.js, which imports index.js (which starts the server).
// Mock the router module so this test only exercises registration, not the whole app.
vi.mock('../routes/gtd.js', () => ({ default: function gtdRouter() {} }));

import { createPluginRegistry } from './registry.js';
import { loadBundledPlugins } from './loadPlugins.js';

describe('loadBundledPlugins', () => {
  it('registers the GTD plugin as Tier-1 mounted at /api/gtd', () => {
    const r = createPluginRegistry();
    loadBundledPlugins(r);
    const gtd = r.get('gtd');
    expect(gtd).toBeTruthy();
    expect(gtd.tier).toBe(1);
    expect(gtd.router.base).toBe('/api/gtd');
    expect(typeof gtd.router.handler).toBe('function');
  });
  it('registers the private local calendar and notes without background sync hooks', () => {
    const registry = loadBundledPlugins(createPluginRegistry());
    expect(registry.get('local-calendar')).toMatchObject({ name: 'MailFlow calendar', tier: 1, router: { base: '/api/local-calendar' } });
    expect(registry.get('local-calendar').sync).toBeUndefined();
    expect(registry.get('private-notes')).toBeTruthy();
  });

});
