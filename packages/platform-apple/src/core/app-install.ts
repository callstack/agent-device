import type { DeviceInfo } from '@agent-device/kernel/device';
import { ensureBootedSimulator } from './simulator.ts';
import { invalidateIosAppResolutionCache } from './app-resolution.ts';
import { runSimctl } from './apps-simctl.ts';
import { resolveIosPhysicalDeviceControl } from './physical-device-control.ts';

type IosInstallSignalOptions = {
  signal?: AbortSignal;
};

export async function installIosInstallablePath(
  device: DeviceInfo,
  installablePath: string,
  options: IosInstallSignalOptions = {},
): Promise<void> {
  await invalidateIosAppResolutionCache(device, async () => {
    options.signal?.throwIfAborted();
    if (device.kind !== 'simulator') {
      await resolveIosPhysicalDeviceControl(device).installApp(
        device,
        installablePath,
        options.signal,
      );
      return;
    }

    await ensureBootedSimulator(device, { signal: options.signal });
    await runSimctl(device, ['install', device.id, installablePath], { signal: options.signal });
  });
}
