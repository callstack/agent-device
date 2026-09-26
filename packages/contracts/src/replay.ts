import type { DaemonError } from '@agent-device/kernel/errors';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { Rect, SnapshotState } from '@agent-device/kernel/snapshot';
import type { GestureExecutionProfile } from './gesture-plan-types.ts';
import type { SessionScope } from './session-scope.ts';
import type { SnapshotDiagnosticsSummary } from './snapshot-diagnostics.ts';
import type {
  LocalIdentity,
  NodeStructuralDenotation,
  TargetAncestryEntry,
  TargetAnnotationV1,
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
  /** Warnings accumulated before the failing step (skipped `optional` steps, capture degradations). */
  warnings?: string[];
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

declare const REPLAY_OBSERVATION_EVIDENCE: unique symbol;

/**
 * Opaque capture lineage a replay engine may carry as data but cannot use to publish refs.
 * Only the daemon-owned finalizer behind {@link ReplayObservationAuthority} can resolve it.
 */
export type ReplayObservationEvidence = {
  readonly [REPLAY_OBSERVATION_EVIDENCE]: true;
};

export type ReplayObservationCapture = Readonly<{
  evidence: ReplayObservationEvidence;
  refsGeneration: number;
}>;

export type ReplayRefPublicationProjection = Readonly<{
  refsGeneration: number | undefined;
  refs: readonly string[];
}>;

export type ReplayRefPublicationResult =
  | Readonly<{ published: true; refsGeneration: number; refCount: number }>
  | Readonly<{
      published: false;
      reason: 'empty' | 'cancelled' | 'stale-capture' | 'invalid-projection';
    }>;

/**
 * The daemon-owned authority a replay run uses to record an operational capture and, once its
 * own projection is exact, to activate exactly the refs that projection exposed. The capability is
 * already bound to one admitted session: a holder cannot name or reacquire another one.
 */
export type ReplayObservationAuthority = Readonly<{
  store(snapshot: SnapshotState): ReplayObservationCapture;
  finalize(
    evidence: ReplayObservationEvidence,
    projection: ReplayRefPublicationProjection,
  ): ReplayRefPublicationResult;
}>;

/**
 * Binds that authority for one request scope. A replay run receives the binder, never the
 * session-store pair the binding is drawn from.
 */
export type ReplayObservationAuthorityBinder = (signal?: AbortSignal) => ReplayObservationAuthority;

/** Runs before an `open` dispatches; a failure response aborts the dispatch with it. */
export type ReplayOpenLifecycle = Readonly<{
  beforeDispatch: () => Promise<DaemonResponse | undefined>;
}>;

/**
 * What a replay-issued dispatch asks the daemon to honor beyond the wire request. Declared once:
 * the daemon's request-private half extends this shape, and the replay port emits it, so a key
 * renamed on one side fails to compile on the other instead of being silently ignored.
 */
export type ReplayDispatchOptions = Readonly<{
  /**
   * PROVENANCE, set by the replay runtime on every action it dispatches from a replay plan,
   * annotated or not. It marks the action as AUTHORED (it came from the `.ad` under repair) rather
   * than typed out-of-band by the agent mid-repair. The repair-segment exclusion keys off its
   * ABSENCE: an authored `get`/`is`/`find`/`snapshot` step must survive into its own healed script,
   * while an interactive diagnostic read used only to LOCATE the repair target must not.
   * Trustworthy because the private half is daemon-only: the transport never copies it off the
   * wire, so no client can spoof authored provenance.
   */
  replayPlanStep?: boolean;
  /**
   * Implicit caller scope resolved before a nested dispatch replaces the public session name with
   * its effective scoped key.
   */
  resolvedSessionScope?: SessionScope;
  /**
   * ADR 0012 step 4 post-resolution guard: the verified target member's normalized local identity
   * AND structural denotation (document order + sibling ordinal), set ONLY by the replay step loop
   * when dispatching an annotated action whose pre-action verification passed. Interaction handlers
   * thread it into command options as `expectedResolvedTarget`; dispatch's own resolution refuses
   * (pre-action) when its winner differs in local identity OR structural position.
   */
  replayTargetGuard?: ReplayTargetGuardDenotation;
  /** Dual-endpoint counterpart of `replayTargetGuard` for target-authored drag. */
  replayTargetGuards?: Readonly<{
    source: ReplayTargetGuardDenotation;
    destination: ReplayTargetGuardDenotation;
  }>;
  /**
   * ADR 0012 / #1349 deferred (post-resolution) identity verification: the recorded `target-v1`
   * landmark of an annotated selector `wait`, set ONLY by the replay step loop. The wait dispatch
   * threads it into the polling loop as `recordedLandmark`; success then requires a selector match
   * carrying this identity, and a timeout with rejected candidates surfaces the
   * `WAIT_LANDMARK_MISMATCH_REASON` refusal the step loop converts into an identity-mismatch
   * divergence.
   */
  replayLandmarkGuard?: TargetAnnotationV1;
  openLifecycle?: ReplayOpenLifecycle;
  /** Terminate the targeted app without ending the owning daemon session. */
  closeAppOnly?: boolean;
  /**
   * With `closeAppOnly`: Maestro `killApp` system-initiated process death
   * (`am kill` on Android, `stopApp` alias elsewhere) instead of `stop`.
   */
  killApp?: boolean;
  /**
   * Daemon-composed hierarchy capture used as operational evidence only. It must not issue or
   * replace client ref authority.
   */
  observationOnly?: true;
  /** Provider-owned viewport already resolved while normalizing a nested gesture command. */
  gestureViewport?: Rect;
  /** Maestro-compat execution profile for timed coordinate swipes projected to `gesture pan`. */
  gestureExecutionProfile?: GestureExecutionProfile;
  /**
   * Maestro `setPermissions` app targeting. The `settings permission`
   * positionals carry no app slot, so the Maestro adapter threads an explicit
   * appId here; the settings handler prefers it over the session app.
   */
  settingsAppBundleId?: string;
}>;
