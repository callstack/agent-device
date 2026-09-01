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

export type SnapshotSurfaceLoaders = Readonly<{
  linux: SnapshotSurfaceLoader;
  macos: SnapshotSurfaceLoader;
}>;

export function createSnapshotRuntimeHost(loaders: SnapshotSurfaceLoaders): SnapshotRuntimeHost {
  const captureSurface: SnapshotRuntimeHost['captureSurface'] = async (device, options, signal) => {
    if (device.platform === 'linux') return await loaders.linux(options, signal);
    requireMacOsSurfaceDevice(device);
    return await loaders.macos(options, signal);
  };
  return Object.freeze({ captureSurface });
}

function requireMacOsSurfaceDevice(device: DeviceInfo): void {
  if (device.platform !== 'apple' || device.appleOs !== 'macos') {
    throw new TypeError('Apple surface capture requires a non-app macOS surface');
  }
}
