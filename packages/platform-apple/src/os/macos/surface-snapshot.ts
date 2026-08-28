import type { CaptureSnapshotInput } from '@agent-device/contracts/snapshot-runtime';
import { shapeDesktopSurfaceSnapshot } from '@agent-device/capture-kit/snapshot-desktop-projection';

type SnapshotSurfaceOptions = NonNullable<CaptureSnapshotInput['options']>;

export async function captureMacOsSurfaceSnapshot(
  options: SnapshotSurfaceOptions,
  signal?: AbortSignal,
) {
  const surface = options.surface;
  if (!surface || surface === 'app') {
    throw new TypeError('Apple surface capture requires a non-app macOS surface');
  }
  const { runMacOsSnapshotAction } = await import('./helper.ts');
  const result = await runMacOsSnapshotAction(surface, {
    bundleId: surface === 'menubar' ? options.appBundleId : undefined,
    signal,
  });
  return shapeDesktopSurfaceSnapshot({ ...result, producer: 'macos-helper' }, options);
}
