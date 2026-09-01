import type { DeviceReadinessRuntimeHost } from '@agent-device/contracts/device-readiness-runtime';
import { listLocalDeviceInventory } from './request/device-inventory-context.ts';
import { runCmdDetached } from '@agent-device/host-kit/command';
import { stopPidsWithEscalation } from '@agent-device/host-kit/process';

export function createAndroidEmulatorHost(): DeviceReadinessRuntimeHost['androidEmulator'] {
  return Object.freeze({
    discover: async (request, signal) => {
      signal.throwIfAborted();
      const devices = await listLocalDeviceInventory(request);
      signal.throwIfAborted();
      return devices;
    },
    launch: (avdName, headless) => {
      const args = ['-avd', avdName];
      if (headless) args.push('-no-window', '-no-audio');
      return runCmdDetached('emulator', args);
    },
    terminate: async (pid) => {
      await stopPidsWithEscalation({ pids: [pid], termTimeoutMs: 1_500, killTimeoutMs: 1_500 });
    },
  });
}
