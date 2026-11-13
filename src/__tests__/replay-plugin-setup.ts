import { afterEach, beforeEach, vi } from 'vitest';

let registry: Awaited<
  ReturnType<typeof import('@agent-device/plugins/registry').startProviderRegistry>
>;
beforeEach(async () => {
  const [
    { bindReplayBackendResolver },
    { resolveProviderPlugins, startProviderRegistry },
    { storePluginCandidates },
  ] = await Promise.all([
    vi.importActual<typeof import('@agent-device/replay-port/replay-backend-registry')>(
      '@agent-device/replay-port/replay-backend-registry',
    ),
    vi.importActual<typeof import('@agent-device/plugins/registry')>(
      '@agent-device/plugins/registry',
    ),
    vi.importActual<typeof import('@agent-device/plugins/store')>('@agent-device/plugins/store'),
  ]);
  registry = await startProviderRegistry(
    await resolveProviderPlugins(await storePluginCandidates(process.env)),
    process.env,
    {
      adaptWebDriver: async () => {
        throw new Error('Replay test setup cannot start providers');
      },
    },
    'replay-backends',
  );
  await bindReplayBackendResolver(registry.resolveReplayBackend, registry.resolveReplayExecution);
});
afterEach(async () => {
  await registry?.close();
});
