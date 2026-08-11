import { AppError } from '@agent-device/kernel/errors';
import { defineUse } from './platform-runtime-operations.ts';
import type { RecordingScope } from './recording-scope.ts';

export const screenRecordingStartUse = defineUse({
  required: ['screenRecordingStart'],
});
export const screenRecordingRecoveryUse = defineUse({
  required: ['screenRecordingReattach', 'screenRecordingCleanup'],
});
const screenRecordingNoRuntimeUse = defineUse({ required: [] });

/** Fact-only admission preserves start's preferred-fast-path semantics. */
export const screenRecordingAdmissionUse = defineUse({
  required: [],
  preferred: ['screenRecordingStart'],
});

/** The descriptor's exact runtime-bearing uses across every record execution plan. */
export const screenRecordingRuntimePlanUses = Object.freeze([
  screenRecordingStartUse,
  screenRecordingRecoveryUse,
] as const);

export type ScreenRecordingRuntimePlan =
  | Readonly<{
      kind: 'start';
      use: typeof screenRecordingStartUse;
    }>
  | Readonly<{
      kind: 'stop-live';
      use: typeof screenRecordingNoRuntimeUse;
    }>
  | Readonly<{
      kind: 'stop-recovery';
      use: typeof screenRecordingRecoveryUse;
    }>;

export type ScreenRecordingRuntimePlanInput = Readonly<{
  action?: string;
  scope?: string;
  hasLiveHandle?: boolean;
}>;

export function resolveScreenRecordingRuntimePlan(
  input: ScreenRecordingRuntimePlanInput,
): ScreenRecordingRuntimePlan {
  const action = (input.action ?? '').toLowerCase();
  switch (action) {
    case 'start': {
      const scope = input.scope ?? 'app';
      if (!isRecordingScope(scope)) {
        throw new AppError('INVALID_ARGS', 'record scope must be app, device, or system');
      }
      return Object.freeze({
        kind: 'start',
        use: screenRecordingStartUse,
      });
    }
    case 'stop':
      if (input.hasLiveHandle === true) {
        return Object.freeze({
          kind: 'stop-live',
          use: screenRecordingNoRuntimeUse,
        });
      }
      return Object.freeze({
        kind: 'stop-recovery',
        use: screenRecordingRecoveryUse,
      });
    default:
      throw new AppError('INVALID_ARGS', 'record requires start or stop');
  }
}

function isRecordingScope(value: string): value is RecordingScope {
  return value === 'app' || value === 'device' || value === 'system';
}
