import type { SettleObservation } from '@agent-device/contracts/interaction';
import type { StableCaptureLoopResult } from './stable-capture.ts';

/** Report observation failure without failing the completed action. */
export function settleUnavailable(
  base: SettleObservation,
  outcome: Pick<StableCaptureLoopResult, 'captures' | 'waitedMs' | 'quietMs'> | undefined,
  error: unknown,
): { observation: SettleObservation } {
  return {
    observation: {
      ...base,
      captures: outcome?.captures ?? base.captures,
      waitedMs: outcome?.waitedMs ?? base.waitedMs,
      quietMs: outcome?.quietMs ?? base.quietMs,
      hint: `Settle observation unavailable (${error instanceof Error ? error.message : String(error)}). The action itself succeeded; take a snapshot to observe the result.`,
    },
  };
}
