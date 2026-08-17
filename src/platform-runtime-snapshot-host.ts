import type { SnapshotRuntimeHost } from '@agent-device/contracts/platform';
import { shapeDesktopSurfaceSnapshot } from './snapshot/snapshot-desktop-surface.ts';

export function createSnapshotRuntimeHost(): SnapshotRuntimeHost {
  return Object.freeze({
    captureSurface,
  });
}

const captureSurface: SnapshotRuntimeHost['captureSurface'] = async (device, options, signal) => {
  if (device.platform === 'linux') {
    return await captureLinuxSurface(options, signal);
  }
  return await captureMacOsSurface(device, options, signal);
};

async function captureLinuxSurface(
  options: Parameters<SnapshotRuntimeHost['captureSurface']>[1],
  signal: AbortSignal,
) {
  const { snapshotLinux } = await import('./platforms/linux/snapshot.ts');
  const result = await snapshotLinux(options?.surface, signal);
  return shapeDesktopSurfaceSnapshot(
    { nodes: result.nodes, truncated: result.truncated, backend: 'linux-atspi' },
    options ?? {},
  );
}

async function captureMacOsSurface(
  device: Parameters<SnapshotRuntimeHost['captureSurface']>[0],
  options: Parameters<SnapshotRuntimeHost['captureSurface']>[1],
  signal: AbortSignal,
) {
  const surface = options?.surface;
  if (device.platform !== 'apple' || device.appleOs !== 'macos' || !surface || surface === 'app') {
    throw new TypeError('Apple surface capture requires a non-app macOS surface');
  }
  const { runMacOsSnapshotAction } = await import('./platforms/apple/os/macos/helper.ts');
  const result = await runMacOsSnapshotAction(surface, {
    bundleId: surface === 'menubar' ? options?.appBundleId : undefined,
    signal,
  });
  return shapeDesktopSurfaceSnapshot({ ...result, backend: 'macos-helper' }, options ?? {});
}
