import type { DeviceReadinessRuntimeHost } from '@agent-device/contracts/device-readiness-runtime';

export function createAppleAutomationKeepHotHost(): DeviceReadinessRuntimeHost['appleAutomation'] {
  return Object.freeze({
    keepHot: (device) => {
      void import('./platforms/apple/core/runner/runner-client.ts')
        .then(({ prewarmAppleRunnerCache }) => prewarmAppleRunnerCache(device, {}))
        .catch(() => {});
    },
    wasRecentlyObservedBooted: async (device) => {
      const { wasSimulatorRecentlyObservedBooted } =
        await import('./platforms/apple/core/simulator.ts');
      return wasSimulatorRecentlyObservedBooted(device);
    },
    markBooted: (device) => {
      void import('./platforms/apple/core/simulator.ts')
        .then(({ markSimulatorBooted }) => markSimulatorBooted(device))
        .catch(() => {});
    },
  });
}
