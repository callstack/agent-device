import { stampSnapshotIdentity } from '@agent-device/contracts/snapshot-producers';
import type { CaptureSnapshotInput } from '@agent-device/contracts/snapshot-runtime';
import { shapeDesktopSurfaceSnapshot } from '@agent-device/capture-kit/snapshot-desktop-projection';
import { snapshotLinux } from './snapshot.ts';
import { resolveLinuxToolProvider } from './tool-provider.ts';
import type { LinuxToolProvider } from '@agent-device/contracts/linux-tool-provider';
import type { LinuxToolbox } from './toolbox.ts';

/**
 * One Linux surface capture, shaped like every other desktop surface capture. The core no longer
 * routes this: the family's runtime owns it, so a `snapshot` of a Linux device runs here and lands in
 * the request's exec trace through the host the plugin was set up with.
 */
export async function captureLinuxSurfaceSnapshot(
  toolbox: LinuxToolbox,
  own: LinuxToolProvider,
  options: CaptureSnapshotInput['options'],
  signal?: AbortSignal,
) {
  const provider = resolveLinuxToolProvider(own);
  const result = await snapshotLinux(toolbox, provider, options?.surface, signal);
  return shapeDesktopSurfaceSnapshot(
    stampSnapshotIdentity(
      { nodes: result.nodes, truncated: result.truncated },
      { backend: 'linux-atspi', producer: 'linux-atspi' },
    ),
    options ?? {},
  );
}
