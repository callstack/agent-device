import type { SnapshotRuntimeHost } from '@agent-device/contracts/platform';
import { shapeDesktopSurfaceSnapshot } from './core/snapshot-desktop-surface.ts';

export function createSnapshotRuntimeHost(): SnapshotRuntimeHost {
  return Object.freeze({
    apple: Object.freeze({
      captureSurface: captureAppleSurface,
    }),
    linux: Object.freeze({
      captureSurface: captureLinuxSurface,
    }),
  });
}

const captureAppleSurface: SnapshotRuntimeHost['apple']['captureSurface'] = async (
  _device,
  options,
  signal,
) => {
  const surface = options?.surface;
  if (!surface || surface === 'app') {
    throw new TypeError('Apple surface capture requires a non-app macOS surface');
  }
  const { runMacOsSnapshotAction } = await import('./platforms/apple/os/macos/helper.ts');
  const result = await runMacOsSnapshotAction(surface, {
    bundleId: surface === 'menubar' ? options?.appBundleId : undefined,
    signal,
  });
  return shapeDesktopSurfaceSnapshot({ ...result, backend: 'macos-helper' }, options ?? {});
};

const captureLinuxSurface: SnapshotRuntimeHost['linux']['captureSurface'] = async (
  _device,
  options,
  signal,
) => {
  const { snapshotLinux } = await import('./platforms/linux/snapshot.ts');
  const result = await snapshotLinux(options?.surface, signal);
  return shapeDesktopSurfaceSnapshot(
    { nodes: result.nodes, truncated: result.truncated, backend: 'linux-atspi' },
    options ?? {},
  );
};
