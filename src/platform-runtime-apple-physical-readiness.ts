import type { DeviceReadinessRuntimeHost } from '@agent-device/contracts/device-readiness-runtime';

export function createApplePhysicalReadinessHost(): DeviceReadinessRuntimeHost['applePhysical'] {
  return Object.freeze({
    ensureConnected: async (device, signal) => {
      signal.throwIfAborted();
      try {
        const { resolveIosPhysicalDeviceControl } =
          await import('@agent-device/platform-apple/physical-device');
        const control = resolveIosPhysicalDeviceControl(device);
        await control.ensureReady(device, signal);
        signal.throwIfAborted();
      } catch (error) {
        signal.throwIfAborted();
        throw error;
      }
    },
  });
}
