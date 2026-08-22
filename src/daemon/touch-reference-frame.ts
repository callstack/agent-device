import {
  type GestureReferenceFrame,
  inferGestureReferenceFrame,
} from '@agent-device/contracts/scroll-gesture';
import type { SnapshotState } from '@agent-device/kernel/snapshot';

export type TouchReferenceFrame = GestureReferenceFrame;

const snapshotReferenceFrameCache = new WeakMap<SnapshotState, TouchReferenceFrame>();

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

const inferTouchReferenceFrame = inferGestureReferenceFrame;
