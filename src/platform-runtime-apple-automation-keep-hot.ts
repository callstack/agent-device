import type { DeviceReadinessRuntimeHost } from '@agent-device/contracts/device-readiness-runtime';

export function createAppleAutomationKeepHotHost(): DeviceReadinessRuntimeHost['appleAutomation'] {
  return Object.freeze({
    keepHot: (device) => {
      void import('@agent-device/platform-apple/runner/operations')
        .then(({ prewarmAppleRunnerCache }) => prewarmAppleRunnerCache(device, {}))
        .catch(() => {});
    },
    wasRecentlyObservedBooted: async (device) => {
      const { wasSimulatorRecentlyObservedBooted } =
        await import('@agent-device/platform-apple/simulator');
      return wasSimulatorRecentlyObservedBooted(device);
    },
    markBooted: (device) => {
      void import('@agent-device/platform-apple/simulator')
        .then(({ markSimulatorBooted }) => markSimulatorBooted(device))
        .catch(() => {});
    },
  });
}
