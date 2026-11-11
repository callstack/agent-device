import {
  type GestureReferenceFrame,
  inferGestureReferenceFrame,
} from '@agent-device/contracts/scroll-gesture';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type { SnapshotState } from '@agent-device/contracts/snapshot-model';
import { readSnapshotViewportEvidence } from '@agent-device/contracts/capture';
import { AppError, discloseDispatch } from '@agent-device/kernel/errors';

export type TouchReferenceFrame = GestureReferenceFrame;

const snapshotReferenceFrameCache = new WeakMap<SnapshotState, TouchReferenceFrame>();

/** Refuses coordinate-derived input when the capture could not establish its screen origin. */
export function assertSnapshotScreenOrigin(owner: object, label: string): void {
  const viewport = readSnapshotViewportEvidence(owner);
  if (viewport && viewport.kind !== 'reported') {
    throw discloseDispatch(
      new AppError('COMMAND_FAILED', `${label} has no established screen-coordinate origin`, {
        reason: 'window-origin-unknown',
        hint: 'Take a fresh snapshot after the accessibility channel recovers, or use screenshot to choose screen coordinates.',
      }),
      'no',
    );
  }
}

export function getSnapshotReferenceFrame(
  snapshot: SnapshotState | undefined,
): TouchReferenceFrame | undefined {
  if (!snapshot) return undefined;
  const cached = snapshotReferenceFrameCache.get(snapshot);
  if (cached) return cached;

  const inferred = inferTouchReferenceFrame(snapshot.nodes ?? []);
  if (!inferred) return undefined;
  snapshotReferenceFrameCache.set(snapshot, inferred);
  return inferred;
}

export function readSnapshotNodesReferenceFrame(
  nodes: SnapshotNode[],
): TouchReferenceFrame | undefined {
  return getSnapshotReferenceFrame({ nodes, createdAt: 0 });
}

const inferTouchReferenceFrame = inferGestureReferenceFrame;
