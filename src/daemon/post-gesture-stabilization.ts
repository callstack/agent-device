import { emitDiagnostic } from '../utils/diagnostics.ts';
import { isMobilePlatform } from '../kernel/device.ts';
import type { CommandFlags } from '../core/dispatch.ts';
import type { SnapshotState } from '../kernel/snapshot.ts';
import { sleep } from '../utils/timeouts.ts';
import {
  areInteractionSurfaceSignaturesStable,
  buildInteractionSurfaceSignature,
} from './interaction-outcome-policy.ts';
import type { SessionState } from './types.ts';

const STABILIZATION_DEADLINE_MS = 1_500;
const STABILIZATION_INTERVAL_MS = 200;
const STABILIZATION_MIN_ATTEMPTS = 2;

export function markPostGestureStabilization(
  session: SessionState,
  action: string,
  positionals: string[] = [],
  flags?: CommandFlags,
): void {
  if (!supportsPostGestureStabilization(session.device.platform)) return;
  if (!isPostGestureStabilizingAction(action, positionals, flags)) return;
  session.postGestureStabilization = {
    action,
    markedAt: Date.now(),
  };
}

function clearPostGestureStabilization(session: SessionState | undefined): void {
  if (!session?.postGestureStabilization) return;
  session.postGestureStabilization = undefined;
}

export async function capturePostGestureStabilizedResult<T>(params: {
  session: SessionState | undefined;
  capture: () => Promise<T>;
  readSnapshot: (result: T) => SnapshotState;
  initial?: T;
}): Promise<T> {
  const { session, capture } = params;
  const pending = session?.postGestureStabilization;
  if (!session || !supportsPostGestureStabilization(session.device.platform) || !pending) {
    return params.initial ?? (await capture());
  }

  const startedAt = Date.now();
  let attempts = 1;
  let previous = params.initial ?? (await capture());
  let previousSignature = buildInteractionSurfaceSignature(params.readSnapshot(previous).nodes);

  while (
    attempts < STABILIZATION_MIN_ATTEMPTS ||
    Date.now() - startedAt < STABILIZATION_DEADLINE_MS
  ) {
    await sleep(STABILIZATION_INTERVAL_MS);
    attempts += 1;
    const current = await capture();
    const currentSignature = buildInteractionSurfaceSignature(params.readSnapshot(current).nodes);
    if (areInteractionSurfaceSignaturesStable(previousSignature, currentSignature)) {
      clearPostGestureStabilization(session);
      emitDiagnostic({
        level: attempts > 2 ? 'info' : 'debug',
        phase: 'post_gesture_snapshot_stabilized',
        data: {
          action: pending.action,
          attempts,
          durationMs: Date.now() - startedAt,
        },
      });
      return current;
    }
    previous = current;
    previousSignature = currentSignature;
  }

  clearPostGestureStabilization(session);
  emitDiagnostic({
    level: 'warn',
    phase: 'post_gesture_snapshot_stabilization_timeout',
    data: {
      action: pending.action,
      attempts,
      durationMs: Date.now() - startedAt,
    },
  });
  return previous;
}

function isPostGestureStabilizingAction(
  action: string,
  positionals: string[],
  flags: CommandFlags | undefined,
): boolean {
  if (flags?.postGestureStabilization === true) return true;
  if (action === 'swipe' || action === 'scroll') return true;
  return action === 'gesture' && positionals[0] === 'swipe';
}

function supportsPostGestureStabilization(platform: SessionState['device']['platform']): boolean {
  return isMobilePlatform(platform);
}
