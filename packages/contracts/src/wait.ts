/**
 * Machine-readable wait failure taxonomy. These values are carried in
 * `error.details.reason`; callers should branch on them instead of parsing
 * wait error messages.
 *
 * `wait_capture_stalled` means no readable capture established an observation
 * before the deadline and is retriable. `wait_deadline_exceeded` means a later
 * capture consumed the remaining budget after at least one readable capture.
 * `wait_readiness_exhausted` means the deadline cancelled a poll that was still
 * making the target observable; `details.readinessPhase` names the work, and
 * `wait_runner_restart_exhausted` is the same verdict for a runner restart.
 * `wait_target_absent` is the ordinary timeout reason for a selector that was
 * never found. `wait_target_present` is the strict-absence timeout reason when
 * valid captures still contain matches. The remaining reasons describe
 * stability and replay-landmark refusals.
 */
export const WAIT_REASONS = {
  captureStalled: 'wait_capture_stalled',
  deadlineExceeded: 'wait_deadline_exceeded',
  runnerRestartExhausted: 'wait_runner_restart_exhausted',
  readinessExhausted: 'wait_readiness_exhausted',
  targetAbsent: 'wait_target_absent',
  targetPresent: 'wait_target_present',
  stableTimeout: 'wait_stable_timeout',
  landmarkIdentityMismatch: 'wait_landmark_identity_mismatch',
} as const;

export type WaitReason = (typeof WAIT_REASONS)[keyof typeof WAIT_REASONS];

/**
 * Work a platform does before it can observe the target at all: starting the Apple XCTest runner,
 * or discovering the Simulator app process the host AX bridge reads. A platform cancelled during
 * that work names it on the error it throws, through {@link readinessPhaseDetails}.
 */
const READINESS_PHASES = ['runner-start', 'target-discovery'] as const;

export type ReadinessPhase = (typeof READINESS_PHASES)[number];

export function readinessPhaseDetails(phase: ReadinessPhase): { readinessPhase: ReadinessPhase } {
  return { readinessPhase: phase };
}

export function readinessPhaseOf(
  details: Readonly<Record<string, unknown>> | undefined,
): ReadinessPhase | undefined {
  const phase = details?.readinessPhase;
  return READINESS_PHASES.find((candidate) => candidate === phase);
}

/**
 * Public daemon result for `wait`. The runtime-local result carries a `kind`
 * discriminant, but `toDaemonWaitData` intentionally projects the normal daemon
 * payload to this compact shape. The direct iOS selector fast path may still
 * include `kind: 'selector'` additively.
 */
export type WaitCommandResult = {
  waitedMs: number;
  kind?: 'selector';
  text?: string;
  selector?: string;
  captures?: number;
  nodeCount?: number;
  hint?: string;
  warning?: string;
};
