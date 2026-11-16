import type { ReplayEnginePlugin } from 'agent-device/plugins';

/** Native .ad execution and suite scheduling use host-owned dispatch, sessions and cancellation. */
function replayPlugin(): ReplayEnginePlugin<'ad'> {
  return {
    apiVersion: 2,
    kind: 'replay-backend',
    backend: 'ad',
    setup: (host) => {
      if (host.clientVersion !== '0.21.38-dev' && !host.clientVersion.startsWith('0.22.')) {
        throw host.createError('INVALID_ARGS', 'The replay plugin requires agent-device 0.22', {
          reason: 'incompatible_plugin',
          supportedCoreVersions: '>=0.22.0-0 <0.23.0 || 0.21.38-dev',
          hint: 'Install matching agent-device and @agent-device/replay releases, then restart the daemon.',
        });
      }
      return {
        execution: {
          create: async () => {
            const [{ inspectAdReplay, runAdReplay }, { runReplayTestSuite }] = await Promise.all([
              import('@agent-device/ad-replay'),
              import('@agent-device/replay-test'),
            ]);
            return { inspectAdReplay, runAdReplay, runReplayTestSuite };
          },
        },
      };
    },
  };
}

export { replayPlugin as default };
