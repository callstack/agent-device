import type { DaemonError } from '@agent-device/kernel/errors';
import type { SnapshotDiagnosticsSummary } from './snapshot-diagnostics.ts';
import type {
  LocalIdentity,
  NodeStructuralDenotation,
  TargetAncestryEntry,
} from './target-annotation.ts';
import { WAIT_REASONS } from './wait.ts';

/**
 * The verified-member denotation carried on the pre-action guard
 * (`DaemonRequest.internal.replayTargetGuard`): its normalized local identity
 * PLUS the structural discriminator path 6 used to isolate it among same
 * local-identity duplicates. Comparing local identity alone would let a
 * different duplicate (identical id/role/label) pass the guard — the exact
 * verified-but-taps-different-node mis-binding step 4 exists to prevent.
 * Lives in contracts so daemon and command layers can share the guard
 * without depending on the annotation codec package.
 */
export type ReplayTargetGuardDenotation = {
  identity: LocalIdentity;
  structural: NodeStructuralDenotation;
};

/**
 * `details.reason` marker on the pre-action refusal thrown by dispatch's
 * post-resolution guard (`assertExpectedResolvedTarget`,
 * `src/commands/interaction/runtime/resolution.ts`), detected by the replay
 * step loop to convert the refusal into an identity-mismatch target-binding
 * divergence.
 */
export const REPLAY_TARGET_GUARD_MISMATCH_REASON = 'replay_target_guard_mismatch';

/**
 * #1349: `details.reason` marker on the timeout refusal `wait` throws when
 * candidates matching the recorded selector appeared during polling but none
 * ever carried the recorded landmark identity (local identity + leaf-anchored
 * ancestry prefix). The replay step loop converts it into an
 * identity-mismatch target-binding divergence; the wait never reports
 * success.
 */
export const WAIT_LANDMARK_MISMATCH_REASON = WAIT_REASONS.landmarkIdentityMismatch;

/**
 * The compact evidence `wait` retains from its LAST poll whose capture
 * matched the recorded selector: the domain size and the first match's
 * identity/ancestry, enough for the daemon to build the divergence's
 * `targetBinding` payload without shipping node trees through error details.
 */
export type WaitLandmarkMismatchEvidence = {
  matchCount: number;
  observed: LocalIdentity;
  observedAncestry: TargetAncestryEntry[];
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
  /** Present when the owning runtime classified the failure as device/runner infrastructure. */
  infrastructure?: true;
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
  /**
   * The suite's own artifacts root (the parent of every test's `artifactsDir`), as resolved on
   * the host that ran the suite. Absent when the suite produced no attempt (e.g. every source
   * was filtered out). #2246: a remote daemon rewrites this to the caller-local path once the
   * directory has been transferred back, so it always names a path the caller can open.
   */
  artifactsDir?: string;
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
};

/**
 * A **replay script source bundle**: every script file one replay run needs,
 * read and resolved by the CALLER and shipped with the request.
 *
 * `replay <path>` used to send only the path, which the daemon then opened on
 * ITS filesystem. That works only while caller and daemon share a disk; against
 * a remote daemon it fails with `ENOENT` on a path the caller can read (#1802).
 * The bundle removes the class: the daemon never resolves a caller path, so a
 * local run and a remote run read exactly the same bytes.
 *
 * `entry` is the caller-resolved absolute path of the script that was invoked —
 * it is also the display path every error, line reference, and
 * `actionSourcePaths` entry is stated in, and it is always a key of `files`.
 * `files` maps each caller-resolved absolute path to that file's text: one
 * entry for a native `.ad` script, plus one per transitively included flow for
 * Maestro YAML `runFlow`.
 */
export type ReplayScriptSourceBundle = Readonly<{
  entry: string;
  files: Readonly<Record<string, string>>;
}>;
