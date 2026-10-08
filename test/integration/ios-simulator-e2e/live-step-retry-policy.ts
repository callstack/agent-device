import { WAIT_REASONS } from '@agent-device/contracts/wait';
import type { CliJsonResult } from '../cli-json.ts';

/**
 * The wait verdicts that say the observation itself was prevented — the runner restarted,
 * readiness work (runner start, bridge target discovery) ate the budget, or no capture was ever
 * readable. Each is a lane condition on this host, not an answer about the screen: the product
 * itself publishes all three with `retriable: true` and a "then retry" hint on the wire
 * (`wait-polling.ts`), and they are the observed reds of the smoke lane (run 37356199982's
 * `wait_runner_restart_exhausted` with `readableCaptures: 0`).
 */
const OBSERVATION_PREVENTED_WAIT_REASONS: ReadonlySet<string> = new Set([
  WAIT_REASONS.captureStalled,
  WAIT_REASONS.runnerRestartExhausted,
  WAIT_REASONS.readinessExhausted,
]);

/**
 * Whether one failed E2E step's result says the DEVICE prevented the observation, so re-issuing
 * the same step is a measurement of the same question rather than a second bite at a real defect.
 *
 * Keyed on the conjunction of two typed signals — the wire `retriable` verdict the daemon hoists
 * from its throw sites AND `error.details.reason` from the wait taxonomy — never on error text.
 * Either signal alone is too wide: `retriable` also rides failures the lane must not re-issue
 * blind (e.g. an app the lane itself is expected to have launched via another route), and a reason
 * set copied onto a response the product marks non-retriable would retry a verdict the product
 * says cannot succeed unchanged. The pairing is pinned in
 * `test/integration/ios-simulator-e2e-step-retry-policy.test.ts`.
 *
 * `wait_target_absent` (the screen was readable and simply did not hold the target),
 * `wait_deadline_exceeded` (a readable capture consumed the budget), a wrong assertion value, a
 * runner crash, and any non-wait failure are all non-retriable by this predicate.
 */
export function isObservationPreventedStepMiss(result: CliJsonResult): boolean {
  const error = result.json?.error;
  if (!error || result.status === 0) return false;
  return error.retriable === true && OBSERVATION_PREVENTED_WAIT_REASONS.has(error.details?.reason);
}
