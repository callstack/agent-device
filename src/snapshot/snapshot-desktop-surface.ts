import type { SnapshotRuntimeHost } from '@agent-device/contracts/snapshot-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';

export function createSnapshotRuntimeHost(): SnapshotRuntimeHost {
  return Object.freeze({ captureSurface });
}

const captureSurface: SnapshotRuntimeHost['captureSurface'] = async (device, options, signal) => {
  if (device.platform === 'linux') {
    const { captureLinuxSurfaceSnapshot } = await import('../platforms/linux/surface-snapshot.ts');
    return await captureLinuxSurfaceSnapshot(options, signal);
  }
  requireMacOsSurfaceDevice(device);
  const { captureMacOsSurfaceSnapshot } =
    await import('../platforms/apple/os/macos/surface-snapshot.ts');
  return await captureMacOsSurfaceSnapshot(options ?? {}, signal);
};

function requireMacOsSurfaceDevice(device: DeviceInfo): void {
  if (device.platform !== 'apple' || device.appleOs !== 'macos') {
    throw new TypeError('Apple surface capture requires a non-app macOS surface');
  }
}
