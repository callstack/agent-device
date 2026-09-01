import type { CaptureSnapshotInput } from '@agent-device/contracts/snapshot-runtime';
import { shapeDesktopSurfaceSnapshot } from '@agent-device/capture-kit/snapshot-desktop-projection';

export async function captureLinuxSurfaceSnapshot(
  options: CaptureSnapshotInput['options'],
  signal?: AbortSignal,
) {
  const { snapshotLinux } = await import('./snapshot.ts');
  const result = await snapshotLinux(options?.surface, signal);
  return shapeDesktopSurfaceSnapshot(
    {
      nodes: result.nodes,
      truncated: result.truncated,
      backend: 'linux-atspi',
      producer: 'linux-atspi',
    },
    options ?? {},
  );
}
