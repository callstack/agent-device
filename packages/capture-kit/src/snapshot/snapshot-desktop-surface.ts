import type {
  CaptureSnapshotInput,
  SnapshotResult,
  SnapshotRuntimeHost,
} from '@agent-device/contracts/snapshot-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';

export type SnapshotSurfaceLoader = (
  options: CaptureSnapshotInput['options'],
  signal?: AbortSignal,
) => Promise<SnapshotResult>;

/**
 * The surface captures the core still owns. The Linux desktop capture is not one of them: the AT-SPI
 * read is that family's own mechanics, so it lives in the Linux plugin and runs over the host that
 * plugin was set up with (#4676). What remains here is the macOS surface, whose projector the core
 * keeps because the Apple runtime reaches it for a non-app surface.
 */
export type SnapshotSurfaceLoaders = Readonly<{
  macos: SnapshotSurfaceLoader;
}>;

export function createSnapshotRuntimeHost(loaders: SnapshotSurfaceLoaders): SnapshotRuntimeHost {
  const captureSurface: SnapshotRuntimeHost['captureSurface'] = async (device, options, signal) => {
    requireMacOsSurfaceDevice(device);
    return await loaders.macos(options, signal);
  };
  const presentIosAcquisition: SnapshotRuntimeHost['presentIosAcquisition'] = async (
    input,
    options,
  ) => {
    const { presentIosSnapshotAcquisition } = await import('./ios-snapshot-runtime.ts');
    return await presentIosSnapshotAcquisition(input, options);
  };
  return Object.freeze({ captureSurface, presentIosAcquisition });
}

function requireMacOsSurfaceDevice(device: DeviceInfo): void {
  if (device.platform !== 'apple' || device.appleOs !== 'macos') {
    throw new TypeError('Apple surface capture requires a non-app macOS surface');
  }
}
