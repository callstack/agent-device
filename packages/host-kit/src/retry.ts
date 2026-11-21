export {
  Deadline,
  type DeadlineClock,
  isEnvTruthy,
  type Limit,
  openScope,
  pollUntilSettled,
  retryWithPolicy,
  RETRY_PHASE,
  type Scope,
} from './internal/retry.ts';
// The timer is published beside the policy and stays a dependency-free leaf: pacing itself reads no
// command host and emits no diagnostic, and the platform policy reads that difference.
export { sleep } from './internal/sleep.ts';
