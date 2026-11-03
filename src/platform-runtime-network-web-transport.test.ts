import { expect, test } from 'vitest';
import { withWebProvider } from '@agent-device/platform-web';
import { resolveWebNetworkTransport } from './platform-runtime-network-web-transport.ts';

const web = {
  platform: 'web' as const,
  id: 'browser',
  name: 'Browser',
  kind: 'device' as const,
  target: 'desktop' as const,
  booted: true,
};

test('never falls back to the default browser session for a network dump', async () => {
  const unscoped = await resolveWebNetworkTransport(web);
  expect(unscoped.mode).toBe('local');
  expect('dump' in unscoped && unscoped.dump).toBeFalsy();

  const limits: Array<number | undefined> = [];
  await withWebProvider(
    {
      dumpNetwork: async (options: { limit?: number }) => {
        limits.push(options.limit);
        return { entries: [], backend: 'agent-browser' };
      },
    } as never,
    async () => {
      const scoped = await resolveWebNetworkTransport(web);
      if (scoped.mode !== 'transport-composed' || !scoped.dump) {
        throw new Error('missing scoped web network transport');
      }
      await scoped.dump({ maxEntries: 7, include: 'summary' } as never);
    },
  );
  expect(limits).toEqual([7]);
});
