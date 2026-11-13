import { aroundEach } from 'vitest';
import { createRuntimeStateHandle } from '@agent-device/host-kit/runtime-slots';

aroundEach(async (runTest) => {
  const state = createRuntimeStateHandle();
  try {
    await state.run(async () => {
      const [
        { bindReplayBackendResolver },
        { resolveProviderPlugins, startProviderRegistry },
        { storePluginCandidates },
      ] = await Promise.all([
        import('@agent-device/replay-port/replay-backend-registry'),
        import('@agent-device/plugins/registry'),
        import('@agent-device/plugins/store'),
      ]);
      const registry = await startProviderRegistry(
        await resolveProviderPlugins(await storePluginCandidates(process.env)),
        process.env,
        {
          adaptWebDriver: async () => {
            throw new Error('Replay test setup cannot start providers');
          },
        },
        'replay-backends',
      );
      await bindReplayBackendResolver(registry.resolveReplayBackend);
      try {
        await runTest();
      } finally {
        await registry.close();
      }
    });
  } finally {
    state.dispose();
  }
});
