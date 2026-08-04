import type { DaemonError } from '@agent-device/kernel/errors';
import type { SnapshotDiagnosticsSummary } from './snapshot-diagnostics.ts';
import { WAIT_REASONS } from './wait.ts';

/**
 * The verified snapshot member carried into the pre-action interaction guard.
 * These neutral shapes live in contracts so daemon and command layers can
 * share the guard without depending on the annotation codec package.
 */
export type ReplayTargetGuardDenotation = {
  identity: { id?: string; role: string; label?: string };
  structural: { documentOrder: number; sibling: number };
};

export const REPLAY_TARGET_GUARD_MISMATCH_REASON = 'replay_target_guard_mismatch';

export const WAIT_LANDMARK_MISMATCH_REASON = WAIT_REASONS.landmarkIdentityMismatch;

/** Compact evidence retained by a selector wait's final mismatching poll. */
export type WaitLandmarkMismatchEvidence = {
  matchCount: number;
  observed: { id?: string; role: string; label?: string };
  observedAncestry: { role: string; label?: string }[];
};

export type ReplayCommandResult = {
  replayed: number;
  healed: number;
  session: string;
  /**
   * True iff `session` still exists in the daemon's session store when the
   * response is built. This remains true when replay suppresses an authored
   * terminal `close` for an explicit live-session handoff. The client uses
   * this, not script parsing, to decide whether an owned one-shot daemon must
   * stay alive so the caller can keep addressing this session.
   */
  sessionActive: boolean;
  artifactPaths: string[];
  warnings?: string[];
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
  message: string;
};

export type ReplaySuiteTestSkipReason = 'skipped-by-filter';

export type ReplaySuiteAttemptFailure = {
  attempt: number;
  message: string;
  durationMs?: number;
};

export type ReplaySuiteTestPassed = {
  file: string;
  title?: string;
  session: string;
  status: 'passed';
  durationMs: number;
  finalAttemptDurationMs?: number;
  attempts: number;
  artifactsDir?: string;
  replayed: number;
  healed: number;
  warnings?: string[];
  attemptFailures?: ReplaySuiteAttemptFailure[];
  shardIndex?: number;
  shardCount?: number;
  deviceId?: string;
  deviceName?: string;
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
};

export type ReplaySuiteTestFailed = {
  file: string;
  title?: string;
  session: string;
  status: 'failed';
  durationMs: number;
  attempts: number;
  artifactsDir?: string;
  error: DaemonError;
  shardIndex?: number;
  shardCount?: number;
  deviceId?: string;
  deviceName?: string;
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
};

export type ReplaySuiteTestSkipped = {
  file: string;
  title?: string;
  status: 'skipped';
  durationMs: 0;
  reason: ReplaySuiteTestSkipReason;
  message: string;
};

export type ReplaySuiteTestResult =
  | ReplaySuiteTestPassed
  | ReplaySuiteTestFailed
  | ReplaySuiteTestSkipped;

export type ReplaySuiteResult = {
  total: number;
  executed: number;
  passed: number;
  failed: number;
  skipped: number;
  notRun: number;
  durationMs: number;
  failures: ReplaySuiteTestFailed[];
  tests: ReplaySuiteTestResult[];
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
};
