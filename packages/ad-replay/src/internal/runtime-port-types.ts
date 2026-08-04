import type { SessionAction } from '@agent-device/contracts/session';
import type { SnapshotTimingSample } from '@agent-device/contracts/capture';
import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type { TargetAnnotationV1 } from '@agent-device/contracts/replay';
import type { ReplayDivergenceTargetBindingKind } from '@agent-device/contracts/divergence';
import type { buildReplayVarScope, LocalIdentity } from '@agent-device/ad-script';
import type {
  AdReplayGuardMismatchEvidence,
  AdReplayLandmarkMismatchEvidence,
  AdReplayTargetStructuralDenotation,
} from './target-verification.ts';

/**
 * #1478 P5 stage C2b (split out of `step-loop.ts` by the #1555 structural-
 * quality review, "split step-loop.ts per the maestro precedent it cites"):
 * the boundary vocabulary between the engine and the daemon —
 * `AdReplayStepRuntime` (the injected capability bag) and every plain-value
 * type its signatures reference. Modeled on `packages/maestro`'s own
 * `runtime-port-types.ts` (`MaestroRuntimeOperations` and its neutral
 * vocabulary). Nothing here is `DaemonRequest`, `DaemonError`,
 * `DaemonResponse`, or `SessionStore` — see `../index.ts`'s header for the
 * full boundary rationale.
 */

/**
 * `${VAR}` scope inputs — plain data (builtins/file/shell/cli env) the
 * daemon reads from the request/process and passes in; `runAdReplay` builds
 * the scope from this. Derived structurally off `buildReplayVarScope`
 * (`@agent-device/ad-script` does not export its own `ReplayVarSources` type
 * by name) rather than duplicating the shape.
 */
export type AdReplayVarSources = Parameters<typeof buildReplayVarScope>[0];

/**
 * A `${VAR}` value eligible for divergence-report redaction — the engine's
 * own scrub list (`collectReplayScrubbableVarValues` over its live scope),
 * threaded to the daemon's build-failure/`handleActionFailure` capabilities
 * as an explicit argument rather than recomputed daemon-side from a second
 * scope object.
 */
export type AdReplayScrubValue = Readonly<{ name: string; value: string }>;

/** Neutral per-step failure: no `DaemonResponse`, no wire shape — just what the engine needs to report. */
export type AdReplayStepFailure = Readonly<{
  /** The daemon's own error/divergence discriminant (e.g. a `DaemonError.code`), carried opaquely. */
  readonly kind: string;
  readonly message: string;
  readonly artifactPaths: readonly string[];
}>;

/**
 * `verify-dispatch.ts`'s per-dispatch result: pass, or a neutral failure
 * (never a wire response). An `ok` outcome's `artifactPaths` is the run's
 * whole artifact ledger as of this step, threaded straight through from
 * `dispatchStep` — see `AdReplayStepRuntime.dispatchStep`.
 */
export type AdReplayStepOutcome =
  | Readonly<{ readonly status: 'ok'; readonly artifactPaths: readonly string[] }>
  | Readonly<{ readonly status: 'failed'; readonly failure: AdReplayStepFailure }>;

/**
 * A single progress step, structurally mirroring
 * `@agent-device/replay-test`'s `ReplayTestAttemptStep` — deliberately not
 * imported from that package (engine-to-engine imports are 0 by design). The
 * daemon adapter's sink is structurally compatible, so no translation layer
 * is needed at the call site.
 */
export type AdReplayProgressStep = Readonly<{
  readonly index: number;
  readonly total: number;
  readonly command?: string;
  readonly value?: string;
}>;

export type AdReplayProgressSink = (step: AdReplayProgressStep) => void;

// ---------------------------------------------------------------------------
// Target-verification neutral types: the plain-value shapes that cross the
// engine/daemon boundary for the verify-then-dispatch flow. `SnapshotNode`,
// `LocalIdentity`, and `TargetAnnotationV1` are already shared/neutral types
// (kernel + ad-script + contracts) — never a `DaemonResponse` or a
// daemon-request-shaped value.
// ---------------------------------------------------------------------------

/**
 * The verified member's identity + structural denotation, threaded to
 * dispatch as its own pre-action guard (so dispatch's independent resolution
 * — occlusion/visibility guards this engine does not replicate — must land
 * on the SAME element or refuse).
 */
export type AdReplayVerifiedTargetGuard = Readonly<{
  expected: Readonly<{
    identity: LocalIdentity;
    structural: AdReplayTargetStructuralDenotation;
  }>;
  matchCount: number;
}>;

/** `captureObservation`'s neutral result: nodes for classification, or why a capture was not available. */
export type AdReplayObservation = Readonly<
  | { readonly state: 'available'; readonly nodes: readonly SnapshotNode[] }
  | { readonly state: 'unavailable'; readonly reason: string; readonly hint?: string }
>;

/**
 * `beginTargetVerification`'s per-command routing, only ever called when
 * `action.targetEvidence` is present: no active session (skip entirely), the
 * post-resolution (`wait`) phase (needs only whether this is a selector
 * wait), or the ordinary pre-dispatch gate (needs the resolved-target token
 * and the session's platform).
 */
export type AdReplayVerificationEntry = Readonly<
  | { readonly kind: 'inactive' }
  | { readonly kind: 'post-resolution'; readonly isSelectorWait: boolean }
  | {
      readonly kind: 'pre-dispatch';
      readonly token: string | undefined;
      readonly platform: Platform | PublicPlatform;
    }
>;

/** `classifyTarget`'s result: a verified guard, or the divergence evidence a target-binding failure reports. */
export type AdReplayTargetClassification = Readonly<
  | { readonly verified: true; readonly guard: AdReplayVerifiedTargetGuard }
  | Readonly<{
      readonly verified: false;
      readonly kind: ReplayDivergenceTargetBindingKind;
      readonly matchCount: number | undefined;
      readonly observed: LocalIdentity | undefined;
      readonly candidateNodes: readonly SnapshotNode[];
      readonly mismatches: readonly string[];
      readonly causeCode: string;
      readonly causeMessage: string;
    }>
>;

/** The evidence bag `buildTargetBindingFailure`/`buildPostDispatchTargetBindingFailure` wrap into a wire divergence. */
export type AdReplayTargetBindingEvidence = Readonly<{
  kind: ReplayDivergenceTargetBindingKind;
  matchCount: number | undefined;
  observed: LocalIdentity | undefined;
  candidateNodes: readonly SnapshotNode[];
  mismatches: readonly string[];
  causeCode: string;
  causeMessage: string;
  causeHint?: string;
}>;

/** The pre-action guard `dispatchStep` threads to the interaction layer's own resolution. */
export type AdReplayDispatchGuard = Readonly<
  | { readonly kind: 'target'; readonly guard: AdReplayVerifiedTargetGuard }
  | { readonly kind: 'landmark'; readonly landmark: TargetAnnotationV1 }
>;

/**
 * `dispatchStep`'s result: ok, an ordinary failure, or one of the two
 * post-resolution identity-refusal markers. The mismatch variants still
 * carry a `plainFailure` — the ordinary neutral failure the dispatch itself
 * produced — so the orchestrator can fall back to it unconverted on the
 * "marker fired without recorded evidence" invariant-violation path, exactly
 * like the daemon code this replaces.
 *
 * #1555 review P1 (second pass, "translate wire failures before the engine
 * boundary"): each mismatch variant carries its OWN typed `evidence` —
 * `AdReplayGuardMismatchEvidence`/`AdReplayLandmarkMismatchEvidence` — never
 * a generic `details: Record<string, unknown>` wire-response bag. The daemon
 * adapter narrows the wire response into one of these two shapes before
 * returning it here, so this outcome never carries an untyped value across
 * the engine boundary.
 */
export type AdReplayDispatchOutcome = Readonly<
  | { readonly status: 'ok'; readonly artifactPaths: readonly string[] }
  | { readonly status: 'failed'; readonly failure: AdReplayStepFailure }
  | {
      readonly status: 'guard-mismatch';
      readonly evidence: AdReplayGuardMismatchEvidence;
      readonly plainFailure: AdReplayStepFailure;
      readonly artifactPaths: readonly string[];
    }
  | {
      readonly status: 'landmark-mismatch';
      readonly evidence: AdReplayLandmarkMismatchEvidence;
      readonly plainFailure: AdReplayStepFailure;
      readonly artifactPaths: readonly string[];
    }
>;

/**
 * The injected capability bag `runAdReplay` threads the step loop through —
 * narrow execute/capture/observe/stamp daemon capabilities, modeled on what
 * the loop actually consumes (`MaestroRuntimeOperations`,
 * `packages/maestro/src/internal/runtime-port-types.ts`, is the precedent).
 * Never `DaemonRequest`, `DaemonError`, `SessionStore`, or a reporter/event
 * stream — and, as of the #1555 review pass, never a `DaemonResponse`
 * either.
 */
export type AdReplayStepRuntime = Readonly<{
  /**
   * Routes one step's recorded target evidence to its verification phase —
   * daemon authority (command-descriptor registry lookup, session read,
   * wait-form parse, token extraction). Only ever called when
   * `action.targetEvidence` is present. `resolvedAction` is `action` with
   * every `${VAR}` already resolved (the engine's own, single resolution for
   * this step) — used only to extract the resolved target token/wait form;
   * `action` (the recorded original) is what routing decisions and any wire
   * report still key on.
   */
  beginTargetVerification(
    action: SessionAction,
    resolvedAction: SessionAction,
    index: number,
  ): AdReplayVerificationEntry;
  /**
   * Captures a fresh snapshot for classification or for a divergence's
   * `screen` — daemon authority (`SessionStore`, the capture pipeline, the
   * #1385 launch-race retry).
   */
  captureObservation(
    action: SessionAction,
    index: number,
    options: { retryLaunchRace: boolean },
  ): Promise<AdReplayObservation>;
  /**
   * Resolves the recorded target against `nodes` using the SAME
   * lookup/matching a real dispatch would — daemon authority (tree helpers and
   * the selectors package engine).
   */
  classifyTarget(params: {
    action: SessionAction;
    index: number;
    token: string;
    nodes: readonly SnapshotNode[];
  }): AdReplayTargetClassification;
  /**
   * Dispatches the action, optionally carrying a pre-action identity guard,
   * and detects the guard-mismatch / wait-landmark-mismatch post-resolution
   * refusal markers on failure — daemon authority (the single `invoke`
   * dispatch site). `resolvedAction` (see `beginTargetVerification`) is what
   * actually gets sent; `action` is threaded alongside it only for
   * daemon-owned, non-interpolation decisions (e.g. a recorded-input
   * variable heuristic read off the ORIGINAL fill text).
   *
   * Sole writer of the run's artifact ledger, and the reason the engine keeps
   * no accumulator of its own: the incoming `artifactPaths` is the PRE-step
   * ledger, and every returned `artifactPaths` is the ledger AFTER this
   * step's entries were recorded — cumulative for the run, not just this
   * step's (#1478 P5 follow-up; see `./step-loop.ts`'s header).
   */
  dispatchStep(
    action: SessionAction,
    resolvedAction: SessionAction,
    index: number,
    artifactPaths: readonly string[],
    guard: AdReplayDispatchGuard | undefined,
  ): Promise<AdReplayDispatchOutcome>;
  /**
   * Builds the "recorded target evidence itself unverifiable" divergence —
   * its own fresh capture — daemon authority (capture, `SessionStore`,
   * resume stamping, wire shaping). `artifactPaths` is the pre-step
   * snapshot (mirrors `dispatchStep`'s own, never artifacts a just-failed
   * dispatch produced — verification never reaches dispatch on this path).
   * `scrubVars` is the engine's own live `${VAR}` scrub list, as of this
   * point in the run.
   */
  buildRecordedUnverifiableFailure(
    action: SessionAction,
    index: number,
    artifactPaths: readonly string[],
    scrubVars: readonly AdReplayScrubValue[],
  ): Promise<AdReplayStepFailure>;
  /**
   * Builds a target-binding divergence from `evidence`, reusing the LAST
   * `captureObservation` result for its `screen` (the pre-dispatch capture
   * and classification/capture-failure evidence share one capture) —
   * daemon authority. `artifactPaths` is the pre-step snapshot, as above;
   * `scrubVars` as above.
   */
  buildTargetBindingFailure(
    action: SessionAction,
    index: number,
    evidence: AdReplayTargetBindingEvidence,
    artifactPaths: readonly string[],
    scrubVars: readonly AdReplayScrubValue[],
  ): Promise<AdReplayStepFailure>;
  /**
   * Builds a target-binding divergence from `evidence` after a FRESH
   * post-dispatch capture (the screen may have changed since dispatch) —
   * daemon authority. `artifactPaths` is the PRE-STEP snapshot passed to
   * `dispatchStep`, not the just-failed dispatch's own artifacts — mirrors
   * the pre-#1555-R3 daemon orchestrator exactly (a target-binding
   * divergence's wire `artifactPaths` never included the triggering
   * dispatch's own); `scrubVars` as above.
   */
  buildPostDispatchTargetBindingFailure(
    action: SessionAction,
    index: number,
    evidence: AdReplayTargetBindingEvidence,
    artifactPaths: readonly string[],
    scrubVars: readonly AdReplayScrubValue[],
  ): Promise<AdReplayStepFailure>;
  /**
   * Wraps a failed step with replay failure diagnostics and repair-held
   * marking — daemon authority (capture, `SessionStore`, the P4b
   * coordinator) — and returns the neutral failure the run outcome reports.
   * `scrubVars` as above.
   */
  handleActionFailure(params: {
    action: SessionAction;
    index: number;
    artifactPaths: readonly string[];
    snapshotDiagnosticSamples: readonly SnapshotTimingSample[];
    scrubVars: readonly AdReplayScrubValue[];
  }): Promise<AdReplayStepFailure>;
  /** Arms the save-script transaction for this step; a no-op absent `--save-script`. Repair authority. */
  armStep(): void;
  /** Whether the request's session currently carries an armed repair boundary. Repair authority. */
  isRepairArmed(): boolean;
  /** The recorded selector's display value for progress reporting, computed by the selectors package. */
  describeStepValue(action: SessionAction): string | undefined;
  /** Optional per-attempt progress sink. */
  onStep?: AdReplayProgressSink;
  /** The current snapshot-diagnostics sample count, as a resumable marker. */
  diagnosticsMarker(): number;
  /** Snapshot-diagnostics samples recorded since `marker`. */
  diagnosticsSince(marker: number): SnapshotTimingSample[];
}>;

export type AdReplayRunRequest = Readonly<{
  readonly actions: readonly SessionAction[];
  /** 0-based loop entry index — already resolved from `--from`/`--plan-digest` daemon-side. */
  readonly entryIndex: number;
  /**
   * #1554: `replay --keep-session` — suppress exactly the plan's terminal
   * close among executable actions (see `resolveSuppressedTerminalCloseIndex`,
   * `step-loop.ts`) so the session survives completion instead of tearing
   * down. Unifies with the pre-existing repair-armed terminal-close
   * suppression: both modes share the SAME structural "terminal among
   * executable actions" resolution, one OR'd into the single suppression
   * check `runAdReplay` makes.
   */
  readonly keepSession: boolean;
  /**
   * Per-action source line, parallel to `actions` — `inspectAdReplay`'s own
   * manifest field, threaded back in here since `runAdReplay` is a separate
   * call from the manifest inspection that produced it. Used only for
   * `${VAR}` interpolation-error location diagnostics (`resolveReplayAction`'s
   * `loc`).
   */
  readonly actionLines: readonly number[];
  /** Per-action resolved source path when it differs from `resolvedPath` (a `runFlow` include's own file), parallel to `actions`. */
  readonly actionSourcePaths: readonly (string | undefined)[] | undefined;
  /** The resolved `.ad` file path — the interpolation-location fallback when an action's own `actionSourcePaths` entry is absent. */
  readonly resolvedPath: string;
  /**
   * `${VAR}` scope inputs — plain data the daemon reads from the request/
   * process (builtins, file/shell/cli env). `runAdReplay` builds the scope
   * from this and performs every `${VAR}` resolution itself (#1555 review
   * P1, "move variable semantics/planning behind the replay entrypoint") —
   * the daemon never resolves an action or builds a scope of its own.
   */
  readonly varSources: AdReplayVarSources;
}>;

/** Neutral run-level outcome: `runAdReplay` never returns or holds a `DaemonResponse`. */
export type AdReplayRunOutcome =
  | Readonly<{
      readonly status: 'completed';
      readonly replayed: number;
      readonly artifactPaths: readonly string[];
      readonly snapshotDiagnosticSamples: readonly SnapshotTimingSample[];
    }>
  | Readonly<{
      readonly status: 'failed';
      readonly stepIndex: number;
      readonly failure: AdReplayStepFailure;
    }>;
