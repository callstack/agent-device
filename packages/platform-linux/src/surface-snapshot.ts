import { stampSnapshotIdentity } from '@agent-device/contracts/snapshot-producers';
import type { CaptureSnapshotInput } from '@agent-device/contracts/snapshot-runtime';
import { shapeDesktopSurfaceSnapshot } from '@agent-device/capture-kit/snapshot-desktop-projection';
import { snapshotLinux } from './snapshot.ts';
import type { LinuxToolProvider } from './tool-provider-types.ts';
import type { LinuxToolbox } from './toolbox.ts';

/**
 * One Linux surface capture, shaped like every other desktop surface capture. The core no longer
 * routes this: the family's runtime owns it, so a `snapshot` of a Linux device runs here and lands in
 * the request's exec trace through the host the plugin was set up with.
 *
 * The caller passes the provider it resolved for its own request, because that is the question each
 * caller answers differently: the runtime and the interactor prefer a provider a request scoped over
 * the one built from their host, and resolve it once per operation rather than per leg of one.
 */
export async function captureLinuxSurfaceSnapshot(
  toolbox: LinuxToolbox,
  provider: LinuxToolProvider,
  options: CaptureSnapshotInput['options'],
  signal?: AbortSignal,
) {
  const result = await snapshotLinux(toolbox, provider, options?.surface, signal);
  return shapeDesktopSurfaceSnapshot(
    stampSnapshotIdentity(
      { nodes: result.nodes, truncated: result.truncated },
      { backend: 'linux-atspi', producer: 'linux-atspi' },
    ),
    options ?? {},
  );
}
