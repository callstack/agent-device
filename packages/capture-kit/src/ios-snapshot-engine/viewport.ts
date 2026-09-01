import type { IosViewportEvidence } from '@agent-device/contracts/ios-snapshot';
import { normalizeType } from '@agent-device/contracts/snapshot';
import type { Rect } from '@agent-device/kernel/snapshot';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';

export type IosSnapshotViewportRoot = Readonly<{
  type?: string;
  rect?: Rect;
  rectStatus?: 'reported' | 'invalid' | 'not-provided';
}>;

export function resolveIosViewportEvidenceFromRoots(
  roots: readonly IosSnapshotViewportRoot[],
  options: Readonly<{ fallbackToLargestRoot?: boolean }> = {},
): IosViewportEvidence | undefined {
  const viewportRoots = roots.filter(isViewportRoot);
  const candidates =
    viewportRoots.length > 0 || options.fallbackToLargestRoot !== true ? viewportRoots : roots;
  const root = [...candidates].sort(compareViewportRoots)[0];
  if (!root) return undefined;
  if (isPositiveFiniteRect(root.rect)) return { kind: 'reported', rect: root.rect };
  return {
    kind: 'missing',
    reason:
      root.rectStatus === 'invalid' || (root.rectStatus === undefined && root.rect !== undefined)
        ? 'invalid'
        : 'not-provided',
  };
}

function isViewportRoot(root: IosSnapshotViewportRoot): boolean {
  const type = normalizeType(root.type ?? '');
  return type === 'application' || type === 'window';
}

function compareViewportRoots(
  left: IosSnapshotViewportRoot,
  right: IosSnapshotViewportRoot,
): number {
  const status = rootGeometryRank(right.rectStatus) - rootGeometryRank(left.rectStatus);
  return status || rectArea(right.rect) - rectArea(left.rect);
}

function rootGeometryRank(status: IosSnapshotViewportRoot['rectStatus']): number {
  return status === 'reported' ? 2 : status === 'invalid' ? 1 : 0;
}

function rectArea(rect: Rect | undefined): number {
  return rect && isPositiveFiniteRect(rect) ? rect.width * rect.height : 0;
}
