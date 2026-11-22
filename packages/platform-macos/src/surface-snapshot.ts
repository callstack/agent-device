import type { MacOsSurfaceSnapshotOptions } from '@agent-device/contracts/macos-platform-leaf';
import type { MacOsToolbox } from './toolbox.ts';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { shapeDesktopSurfaceSnapshot } from '@agent-device/capture-kit/snapshot-desktop-projection';

export async function captureMacOsSurfaceSnapshot(
  box: MacOsToolbox,
  options: MacOsSurfaceSnapshotOptions,
  signal: AbortSignal | undefined,
  env: Readonly<EnvMap>,
) {
  const surface = options.surface;
  const [{ runMacOsSnapshotAction }, { stampSnapshotIdentity }] = await Promise.all([
    import('./helper.ts'),
    import('@agent-device/contracts/snapshot-producers'),
  ]);
  const result = await runMacOsSnapshotAction(box, surface, {
    bundleId: surface === 'menubar' || surface === 'app' ? options.appBundleId : undefined,
    signal,
    env,
  });
  return shapeDesktopSurfaceSnapshot(
    stampSnapshotIdentity(result, { backend: 'macos-helper', producer: 'macos-helper' }),
    options,
  );
}
