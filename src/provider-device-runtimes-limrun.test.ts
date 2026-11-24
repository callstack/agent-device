import { expect, test, vi } from 'vitest';
import type { PlatformHost } from '@agent-device/plugins/contract';
import type { PluginCandidate } from '@agent-device/plugins/registry';
import { createTestHostEnvironment } from '@agent-device/test-kit';
import limrun from '@agent-device/limrun';
import { createDaemonProviderRuntimeComposition } from './provider-device-runtimes.ts';

const store = vi.hoisted(() => vi.fn<() => Promise<PluginCandidate[]>>());

vi.mock('@agent-device/plugins/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/plugins/store')>()),
  storePluginCandidates: store,
}));

test('a hosted attachment daemon refuses an older plugin before setup', async () => {
  const plugin = limrun();
  const provider = plugin.contributes[0];
  const { acceptsHostedAttachment: _current, ...capabilities } = provider.connection!.capabilities;
  const setup = vi.fn();
  const unrelatedLoad = vi.fn();
  store.mockResolvedValueOnce([
    {
      source: 'store',
      package: '@agent-device/limrun',
      load: () => ({
        ...plugin,
        contributes: [
          {
            ...provider,
            setup,
            connection: { ...provider.connection, capabilities },
          },
        ],
      }),
    },
    { source: 'store', package: 'unrelated-fixture', load: unrelatedLoad },
  ]);
  const host = createTestHostEnvironment({
    env: {
      LIMRUN_HOSTED_ATTACHMENT_DEADLINE: new Date(Date.now() + 60_000).toISOString(),
      LIM_IOS_INSTANCE_URL: 'https://instance.example',
      LIM_IOS_INSTANCE_TOKEN: 'fixture-instance-token',
    },
  });
  await expect(
    createDaemonProviderRuntimeComposition(host, {} as PlatformHost),
  ).rejects.toMatchObject({ details: { reason: 'plugin-unavailable' } });
  expect(setup).not.toHaveBeenCalled();
  expect(unrelatedLoad).not.toHaveBeenCalled();
});
