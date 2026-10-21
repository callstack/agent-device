import type { CoordinateTapTextInputEvidence } from '@agent-device/contracts/interactor-types';
import { normalizeType } from '@agent-device/contracts/snapshot';
import type { Point, Rect, SnapshotState } from '@agent-device/kernel/snapshot';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';

const TEXT_INPUT_TYPES = new Set([
  'textfield',
  'securetextfield',
  'searchfield',
  'textview',
  'textarea',
  'search',
  'textbox',
  'searchbox',
]);

export function buildCoordinateTapTextInputEvidence(
  snapshot: SnapshotState | undefined,
  point: Point,
  appBundleId: string | undefined,
  source: CoordinateTapTextInputEvidence['source'],
): CoordinateTapTextInputEvidence | undefined {
  if (!snapshot || snapshot.truncated || snapshot.nodes.length === 0) return undefined;
  if (snapshot.snapshotQuality?.state === 'sparse') return undefined;
  const targetBundleId = snapshot.iosSystemSurfaceBundleId ?? appBundleId;
  if (!targetBundleId) return undefined;
  const textInputRects: Rect[] = [];
  for (const node of snapshot.nodes) {
    const isInput = [node.type, node.role].some(
      (type) =>
        type !== undefined && TEXT_INPUT_TYPES.has(normalizeType(type).replaceAll(/[-_ ]/g, '')),
    );
    if (!isInput) continue;
    if (!isPositiveFiniteRect(node.rect)) return undefined;
    textInputRects.push(node.rect);
  }
  return { source, targetBundleId, point, textInputRects };
}
