import type { AppleApplicationTools } from '@agent-device/contracts/application-lifecycle-runtime';
import { createAppleRunnerRuntime } from '@agent-device/platform-apple/runner/operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { LimrunIosRunner } from './runtime-dependencies.ts';

export const iosRunnerDevice: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'limrun:ios:lease-a',
  name: 'Limrun iOS',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

export async function createTestIosRunner(
  respond: (command: Record<string, unknown>) => Record<string, unknown> = () => ({}),
  device = iosRunnerDevice,
): Promise<LimrunIosRunner> {
  const runner = await createAppleRunnerRuntime({
    device,
    host: { env: {}, cwd: process.cwd() },
    provider: {
      hasLiveSession: () => true,
      runCommand: async (_device, command) => respond(command),
    },
  });
  const applicationTools: AppleApplicationTools = {
    resolveOpenTarget: async (_device, input) => ({
      appBundleId: input.target ?? input.currentAppBundleId,
      appName: input.target,
    }),
    prewarmRunnerCache: async () => {},
    prewarmRunnerSession: async () => {},
    notifyRunnerAppRelaunched: async () => {},
    stopRunnerSession: async () => {},
    hasLiveRunnerSession: async () => true,
    releaseSpeculativeRunner: async () => false,
    releaseRunnerOnClose: async () => {},
    prepareRunner: (_device, input, signal) => runner.prepare(input, signal),
    applyRuntimeHints: async () => {},
    clearRuntimeHints: async () => {},
    dismissCloseAlerts: async () => {},
    detachRunnerSessionsForShutdown: async () => [],
    finalizeRunnerSessionsForShutdown: async () => [],
  };
  return {
    ...runner,
    applicationTools,
    bindApplicationLifecycle: (request) => {
      const lifecycle = runner.bindApplicationLifecycle({
        ...request,
        appleApplications: applicationTools,
        ensureReady: async (target) => target,
      });
      return lifecycle;
    },
    dispose: async () => {},
  };
}

export const testIosRunner = await createTestIosRunner();
