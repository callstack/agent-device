import type { GestureIntent } from '@agent-device/contracts/interaction';
import type { Point } from '@agent-device/kernel/snapshot';

type GestureResponseResult = {
  kind: GestureIntent | 'drag';
  durationMs: number;
  pointerCount: 1 | 2;
  from: Point;
  to: Point;
  targets?: unknown;
  backendResult?: Record<string, unknown>;
  message?: string;
};

/** The sole response construction site shared by coordinate and target-authored gestures. */
export function gestureResponseData(
  result: GestureResponseResult,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const executionProfile =
    typeof extra.executionProfile === 'string' ? extra.executionProfile : undefined;
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
          timing: {
            executionProfile,
            gestureDurationMs: result.durationMs,
          },
        }
      : {}),
    message: result.message,
  };
}
