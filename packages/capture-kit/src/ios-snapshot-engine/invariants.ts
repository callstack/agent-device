import type {
  IosSnapshotAcquisition,
  IosViewportEvidence,
} from '@agent-device/contracts/ios-snapshot';
import type { Rect, RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { containsPoint, rectContains, isPositiveFiniteRect } from '@agent-device/kernel/rect';
import { normalizeType } from '@agent-device/contracts/snapshot';
import { validateIosSnapshotGraph } from './graph.ts';
import { IosSnapshotEngineError } from './types.ts';
import type { IosSnapshotFoldPolicy } from './types.ts';

const SCROLL_CONTAINER_TYPES = new Set(['collectionview', 'scrollview', 'table']);

export function resolveIosViewport(acquisition: IosSnapshotAcquisition): Rect {
  return resolveViewportEvidence(acquisition.viewport);
}

export function resolveViewportEvidence(evidence: IosViewportEvidence): Rect {
  if (evidence.kind === 'missing') {
    throw new IosSnapshotEngineError(
      evidence.reason === 'invalid' ? 'invalid-viewport' : 'missing-viewport',
      'regular iOS snapshot presentation requires a valid viewport',
      { field: 'viewport' },
    );
  }
  if (!isPositiveFiniteRect(evidence.rect)) {
    throw new IosSnapshotEngineError(
      'invalid-viewport',
      'regular iOS snapshot presentation requires a positive finite viewport',
      { field: 'viewport' },
    );
  }
  return evidence.rect;
}

function validateIosRegularInvariant(
  nodes: readonly RawSnapshotNode[],
  viewport: Rect,
  policy: IosSnapshotFoldPolicy,
  hittabilityAvailable = true,
): { parentClipLookups: number } {
  validateIosSnapshotGraph(nodes);
  const clipByIndex = new Map<number, Rect>();
  let parentClipLookups = 0;

  for (const node of nodes) {
    const ancestorClip = resolveAncestorClip(node, clipByIndex, viewport, () => {
      parentClipLookups += 1;
    });

    const frame = normalizeRect(node.rect);
    validateHittabilityEvidence(node, hittabilityAvailable);
    if (!frame || !isPositiveFiniteRect(frame)) {
      validateDegenerateActionability(node, frame);
      clipByIndex.set(node.index, ancestorClip);
      continue;
    }

    validateContainedFrame(node, frame, ancestorClip);
    validateActionability(node, frame, viewport);

    clipByIndex.set(node.index, clipForNode(node, frame, ancestorClip, policy));
  }
  return { parentClipLookups };
}

function resolveAncestorClip(
  node: RawSnapshotNode,
  clipByIndex: ReadonlyMap<number, Rect>,
  viewport: Rect,
  onParentLookup: () => void,
): Rect {
  if (node.parentIndex === undefined) return viewport;
  onParentLookup();
  const parentClip = clipByIndex.get(node.parentIndex);
  if (!parentClip) {
    throw new IosSnapshotEngineError(
      'invalid-presented-payload',
      'regular iOS snapshot payload refers to a parent outside the payload',
      { index: node.index, parentIndex: node.parentIndex },
    );
  }
  return parentClip;
}

function validateHittabilityEvidence(node: RawSnapshotNode, available: boolean): void {
  if (node.hittable !== true || available) return;
  throw new IosSnapshotEngineError(
    'invalid-presented-payload',
    'iOS snapshot payload marked a node actionable without hittability evidence',
    { index: node.index },
  );
}

function validateDegenerateActionability(node: RawSnapshotNode, frame: Rect | undefined): void {
  if (node.hittable !== true) return;
  throw new IosSnapshotEngineError(
    'regular-degenerate-actionable-node',
    'regular iOS snapshot node with a missing or degenerate frame is actionable',
    { index: node.index, frame: frame ?? node.rect },
  );
}

function validateContainedFrame(node: RawSnapshotNode, frame: Rect, clip: Rect): void {
  if (containsWithTolerance(frame, clip)) return;
  throw new IosSnapshotEngineError(
    'regular-node-outside-cumulative-clip',
    'regular iOS snapshot node escaped its cumulative clip',
    { index: node.index, frame, clip },
  );
}

function validateActionability(node: RawSnapshotNode, frame: Rect, viewport: Rect): void {
  if (
    node.hittable !== true ||
    (node.enabled !== false &&
      containsPoint(viewport, frame.x + frame.width / 2, frame.y + frame.height / 2))
  ) {
    return;
  }
  throw new IosSnapshotEngineError(
    'invalid-presented-payload',
    'regular iOS snapshot payload marked a disabled or off-viewport node actionable',
    { index: node.index, frame },
  );
}

function clipForNode(
  node: RawSnapshotNode,
  frame: Rect,
  ancestorClip: Rect,
  policy: IosSnapshotFoldPolicy,
): Rect {
  return policy === 'cursor-projected' && SCROLL_CONTAINER_TYPES.has(normalizeType(node.type ?? ''))
    ? frame
    : ancestorClip;
}

export function validateIosPayload(
  nodes: readonly RawSnapshotNode[],
  projection: 'regular' | 'raw',
  viewport: Rect | undefined,
  policy: IosSnapshotFoldPolicy,
  hittabilityAvailable = true,
): { parentClipLookups: number } {
  if (projection === 'raw') {
    validateIosSnapshotGraph(nodes);
    return { parentClipLookups: 0 };
  }
  if (!viewport) {
    throw new IosSnapshotEngineError(
      'missing-viewport',
      'regular iOS snapshot payload cannot be validated without a viewport',
      { field: 'viewport' },
    );
  }
  try {
    return validateIosRegularInvariant(nodes, viewport, policy, hittabilityAvailable);
  } catch (error) {
    if (error instanceof IosSnapshotEngineError && error.code === 'IOS_SNAPSHOT_ENGINE_FAILED') {
      if (error.reason === 'malformed-graph') {
        throw new IosSnapshotEngineError('invalid-presented-payload', error.message, error.details);
      }
      throw error;
    }
    throw error;
  }
}

function normalizeRect(rect: Rect | undefined): Rect | undefined {
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) {
    return undefined;
  }
  if (rect.width < 0 || rect.height < 0) return undefined;
  return { ...rect, width: Math.max(0, rect.width), height: Math.max(0, rect.height) };
}

function containsWithTolerance(frame: Rect, clip: Rect): boolean {
  const tolerance = 0.0001;
  return rectContains(
    {
      x: clip.x - tolerance,
      y: clip.y - tolerance,
      width: clip.width + tolerance * 2,
      height: clip.height + tolerance * 2,
    },
    frame,
  );
}
