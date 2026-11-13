import type { ReplayEnginePlugin } from 'agent-device/plugins';

/** The managed entry is engine-free. Only a selected backend evaluates the implementation. */
function maestroPlugin(): ReplayEnginePlugin {
  return {
    apiVersion: 2,
    kind: 'replay-backend',
    backend: 'maestro',
    setup: () => ({
      replayBackend: {
        create: async (host) =>
          (
            await import('./replay-backend/replay-maestro-backend.ts')
          ).maestroReplayBackendPlugin.create(host),
      },
    }),
  };
}

export { maestroPlugin as default };
