import { expect, it } from 'vitest';
import { createPluginRegistry } from './registry.js';

it('strips Fastmail credentials before every hook gate and callback without changing core rows', async () => {
  for (const operation of ['hasActive', 'hasActiveAsync', 'runHook', 'collectHook']) {
    const registry = createPluginRegistry(), seen = [];
    const account = { id: 'synthetic-account', fastmail_api_token: 'enc:synthetic-secret', auth_pass: 'legacy-contract', enabled: true };
    const context = { account, changedCount: 3 };
    const inspect = ctx => { seen.push(ctx); return true; };
    registry.register({ id: 'test', name: 'Test', version: '1', tier: 1,
      isActive: inspect, hooks: { inboxIngest: { isActive: inspect, handler: inspect } } });
    await registry[operation]('inboxIngest', context);
    expect(seen.length).toBe(operation.startsWith('hasActive') ? 2 : 3);
    for (const ctx of seen) {
      expect(ctx.account).not.toHaveProperty('fastmail_api_token');
      expect(ctx.account).not.toBe(account);
      expect(ctx.account.auth_pass).toBe('legacy-contract');
      expect(ctx.changedCount).toBe(3);
    }
    expect(account.fastmail_api_token).toBe('enc:synthetic-secret');
    expect(context.account).toBe(account);
  }
});
