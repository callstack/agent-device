import { expect, test } from 'vitest';
import type { NetworkProviderDump } from '@agent-device/contracts/network-runtime';
import { resolveWebNetworkTransport } from './platform-runtime-network-web-transport.ts';
import { makeWebProvider, webSelectionFixture } from './platform-runtime-web-provider.fixtures.ts';

const web = {
  platform: 'web' as const,
  id: 'browser',
  name: 'Browser',
  kind: 'device' as const,
  target: 'desktop' as const,
  booted: true,
};

const webPlugin = webSelectionFixture();

test('never falls back to the default browser session for a network dump', async () => {
  const unscoped = await resolveWebNetworkTransport(web, webPlugin);
  expect(unscoped.mode).toBe('local');
  expect('dump' in unscoped && unscoped.dump).toBeFalsy();

  const limits: Array<number | undefined> = [];
  const dumpInput: Parameters<NetworkProviderDump>[0] = { maxEntries: 7, include: 'summary' };
  await webPlugin.get().withRequestProvider(
    makeWebProvider({
      dumpNetwork: async (options) => {
        limits.push(options?.limit);
        return { entries: [], backend: 'agent-browser' };
      },
    }),
    async () => {
      const scoped = await resolveWebNetworkTransport(web, webPlugin);
      if (scoped.mode !== 'transport-composed' || !scoped.dump) {
        throw new Error('missing scoped web network transport');
      }
      await scoped.dump(dumpInput);
    },
  );
  expect(limits).toEqual([7]);
});
