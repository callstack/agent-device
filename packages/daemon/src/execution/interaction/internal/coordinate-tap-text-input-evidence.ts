import type { CoordinateTapTextInputEvidence } from '@agent-device/contracts/interactor-types';
import { readSnapshotTextInputGeometry } from '@agent-device/contracts/capture';
import type { Point, SnapshotState } from '@agent-device/kernel/snapshot';

export function buildCoordinateTapTextInputEvidence(
  snapshot: SnapshotState | undefined,
  point: Point,
  appBundleId: string | undefined,
  source: CoordinateTapTextInputEvidence['source'],
): CoordinateTapTextInputEvidence | undefined {
  if (!snapshot || snapshot.truncated || snapshot.nodes.length === 0) return undefined;
  if (snapshot.snapshotQuality?.state === 'sparse') return undefined;
  const targetBundleId = snapshot.iosSystemSurfaceBundleId ?? appBundleId;
  const geometry = readSnapshotTextInputGeometry(snapshot.nodes);
  if (!targetBundleId || !geometry) return undefined;
  return { source, targetBundleId, point, textInputRects: geometry.rects };
}
