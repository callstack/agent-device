import type { ReplayEnginePlugin } from 'agent-device/plugins';

/** The managed entry is engine-free. Only a selected backend evaluates the implementation. */
function maestroPlugin(): ReplayEnginePlugin {
  return {
    apiVersion: 2,
    kind: 'replay-backend',
    backend: 'maestro',
    setup: () => {
      let releasePngWorker: (() => Promise<void>) | undefined;
      return {
        replayBackend: {
          create: async (host) => {
            const [{ maestroReplayBackendPlugin }, { retainPngWorker }] = await Promise.all([
              import('./replay-backend/replay-maestro-backend.ts'),
              import('@agent-device/capture-kit/png-worker-client'),
            ]);
            releasePngWorker ??= retainPngWorker((reason) =>
              host.emitDiagnostic({ level: 'warn', phase: 'png_worker_unavailable', data: reason }),
            );
            return await maestroReplayBackendPlugin.create(host);
          },
        },
        dispose: async () => {
          await releasePngWorker?.();
        },
      };
    },
  };
}

export { maestroPlugin as default };
