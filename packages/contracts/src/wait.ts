import type { ReasonTable } from '@agent-device/kernel/errors';

/**
 * Machine-readable wait failure taxonomy, carried in `error.details.reason`. Callers branch on
 * these values instead of parsing wait error messages.
 */
export const WAIT_REASONS = {
  captureStalled: {
    reason: 'wait_capture_stalled',
    summary: 'No readable capture arrived before the deadline, so a retry can succeed.',
    commands: ['wait'],
  },
  deadlineExceeded: {
    reason: 'wait_deadline_exceeded',
    summary: 'A later capture used up the budget after an earlier readable capture.',
    commands: ['wait'],
  },
  runnerRestartExhausted: {
    reason: 'wait_runner_restart_exhausted',
    summary:
      'The deadline ended while the runner restarted to recover a lost response, so a retry can succeed.',
    commands: ['wait'],
  },
  readinessExhausted: {
    reason: 'wait_readiness_exhausted',
    summary:
      'The deadline ended while the target was still being made observable; `details.readinessPhase` names the work.',
    commands: ['wait'],
  },
  targetAbsent: {
    reason: 'wait_target_absent',
    summary: 'A positive wait never found a match.',
    commands: ['wait'],
  },
  targetPresent: {
    reason: 'wait_target_present',
    summary:
      'Strict `wait absent` reached its deadline while valid captures still contained matches.',
    commands: ['wait'],
  },
  stableTimeout: {
    reason: 'wait_stable_timeout',
    summary: '`wait stable` reached its deadline before the UI settled.',
    commands: ['wait'],
  },
  landmarkIdentityMismatch: {
    reason: 'wait_landmark_identity_mismatch',
    summary:
      'A replay destination guard refused the match because its identity differs from the recorded landmark.',
    commands: ['wait', 'replay'],
  },
} as const satisfies ReasonTable;

export type WaitReason = (typeof WAIT_REASONS)[keyof typeof WAIT_REASONS]['reason'];

/**
 * Work a platform does before it can observe the target at all: starting the Apple XCTest runner,
 * or discovering the Simulator app process the host AX bridge reads. Only the code doing that work
 * at the moment of cancellation names it, as `details.readinessPhase` on the error it throws.
 */
const READINESS_PHASES = ['runner-start', 'target-discovery'] as const;

export type ReadinessPhase = (typeof READINESS_PHASES)[number];

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
