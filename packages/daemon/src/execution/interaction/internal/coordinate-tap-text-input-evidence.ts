import type { CoordinateTapTextInputEvidence } from '@agent-device/contracts/interactor-types';
import type { SurfaceScopedNodes } from '@agent-device/contracts/interaction';
import { readSnapshotTextInputGeometry } from '@agent-device/contracts/capture';
import type { Point } from '@agent-device/kernel/snapshot';

export function buildCoordinateTapTextInputEvidence(
  observation: SurfaceScopedNodes,
  point: Point,
  appBundleId: string | undefined,
  source: CoordinateTapTextInputEvidence['source'],
): CoordinateTapTextInputEvidence | undefined {
  const targetBundleId = observation.surfaceBundleId ?? appBundleId;
  const geometry = readSnapshotTextInputGeometry(observation.nodes);
  if (!targetBundleId || !geometry) return undefined;
  return { source, targetBundleId, point, textInputRects: geometry.rects };
}
