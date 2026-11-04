import {
  isGestureExecutedProfile,
  type GestureContactCount,
  type GestureIntent,
} from '@agent-device/contracts/gesture-plan-types';
import type { Point } from '@agent-device/kernel/snapshot';

type GestureResponseResult = {
  kind: GestureIntent | 'drag';
  durationMs: number;
  pointerCount: GestureContactCount;
  from: Point;
  to: Point;
  targets?: unknown;
  backendResult?: Record<string, unknown>;
  message?: string;
};

/**
 * The sole response construction site shared by coordinate and target-authored gestures. The
 * schedule the backend reports it ran wins; the caller's `executionProfile` names the planned
 * schedule only for a backend that reports none.
 */
export function gestureResponseData(
  result: GestureResponseResult,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const reported = result.backendResult?.executionProfile;
  const executionProfile = isGestureExecutedProfile(reported)
    ? reported
    : typeof extra.executionProfile === 'string'
      ? extra.executionProfile
      : undefined;
  return {
    kind: result.kind,
    durationMs: result.durationMs,
    pointerCount: result.pointerCount,
    from: result.from,
    to: result.to,
    ...(result.kind === 'drag' ? { targets: result.targets } : {}),
    ...(result.backendResult ?? {}),
    ...extra,
    ...(executionProfile
      ? {
          executionProfile,
          timing: {
            executionProfile,
            gestureDurationMs: result.durationMs,
          },
        }
      : {}),
    message: result.message,
  };
}
