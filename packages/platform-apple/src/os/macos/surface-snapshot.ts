import type { CaptureSnapshotInput } from '@agent-device/contracts/snapshot-runtime';
import type { MacOsHelperSurface } from '@agent-device/contracts/session';
import { shapeDesktopSurfaceSnapshot } from '@agent-device/capture-kit/snapshot-desktop-projection';

type SnapshotSurfaceOptions = Omit<NonNullable<CaptureSnapshotInput['options']>, 'surface'> & {
  surface: MacOsHelperSurface;
};

export async function captureMacOsSurfaceSnapshot(
  options: SnapshotSurfaceOptions,
  signal?: AbortSignal,
) {
  const surface = options.surface;
  const { runMacOsSnapshotAction } = await import('./helper.ts');
  const result = await runMacOsSnapshotAction(surface, {
    bundleId: surface === 'menubar' ? options.appBundleId : undefined,
    signal,
  });
  return shapeDesktopSurfaceSnapshot({ ...result, producer: 'macos-helper' }, options);
}
