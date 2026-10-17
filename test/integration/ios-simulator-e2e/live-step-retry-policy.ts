import { WAIT_REASONS } from '@agent-device/contracts/wait';
import type { CliJsonResult } from '../cli-json.ts';

// These wait verdicts indicate that capture or readiness prevented observation.
const OBSERVATION_PREVENTED_WAIT_REASONS: ReadonlySet<string> = new Set([
  WAIT_REASONS.captureStalled,
  WAIT_REASONS.runnerRestartExhausted,
  WAIT_REASONS.readinessExhausted,
]);

/** Requires both a retriable verdict and a typed prevented-observation reason.
 * Readable absence, deadline exhaustion, and non-wait failures cannot repeat here.
 */
export function isObservationPreventedStepMiss(result: CliJsonResult): boolean {
  const error = result.json?.error;
  if (!error || result.status === 0) return false;
  return error.retriable === true && OBSERVATION_PREVENTED_WAIT_REASONS.has(error.details?.reason);
}
