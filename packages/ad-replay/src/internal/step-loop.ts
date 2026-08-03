import type { SessionAction } from '@agent-device/contracts/session';
import type { SnapshotTimingSample } from '@agent-device/contracts/capture';
import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type { TargetAnnotationV1 } from '@agent-device/contracts/replay';
import type { ReplayDivergenceTargetBindingKind } from '@agent-device/contracts/divergence';
import {
  buildReplayVarScope,
  collectReplayScrubbableVarValues,
  resolveReplayAction,
  type LocalIdentity,
  type ReplayVarScope,
} from '@agent-device/ad-script';
import type { ReplaySelectorPort } from './selector-port.ts';
import {
  deriveReplayTargetGuardMismatchEvidence,
  deriveWaitLandmarkMismatchEvidence,
  planPostResolutionTargetVerification,
  planPreDispatchTargetVerification,
  type AdReplayGuardMismatchEvidence,
  type AdReplayLandmarkMismatchEvidence,
  type AdReplayTargetStructuralDenotation,
} from './target-verification.ts';

/**
 * #1478 P5 stage C2b: the `.ad` step-loop ENGINE policy, split out of
 * `session-replay-runtime.ts`'s `executeReplayActions` /
 * `resolveReplayStepResponse` / `buildReplayActionFailure`. Everything that
 * touches a real device, a snapshot, `SessionStore`, or the P4b repair
 * coordinator is daemon authority and stays behind the narrow
 * `AdReplayStepRuntime` capabilities below — this module only decides which
 * action to run next, when to skip one, and when to stop.
 *
 * #1555 review P1 ("do not smuggle daemon wire failures through a generic"):
 * `AdReplayStepRuntime` no longer carries a `TResponse` type parameter. The
 * loop never sees a `DaemonResponse`/wire object at all, not even opaquely —
 * the capabilities below return the NEUTRAL tagged types in this file (built
 * only from plain values — a `kind`/`reason` string, a `message` string,
 * snapshot nodes, artifact paths). The daemon adapter
 * (`createAdReplayStepRuntime`, `session-replay-runtime.ts`) is the only
 * place a real `DaemonResponse` is constructed or read; it keeps its OWN
 * wire response in a local variable ("the side-map") as it builds each
 * neutral outcome, and `runReplayScriptFile` reads that variable back after
 * `runAdReplay` reports which step failed, so the final response returned to
 * the client is byte-identical to before this split — it was never
 * round-tripped through the engine's return value at all.
 *
 * #1555 review P1 remainder ("target verification must happen INSIDE the
 * engine"): `verifyAndDispatchStep` below is the verify-then-dispatch
 * orchestrator that used to live daemon-side
 * (`session-replay-target-verification.ts`'s `verifyReplayActionTarget` /
 * `convertIdentityRefusalResponse`) calling OUT to this package's four
 * target-verification policy functions. The call sites for those four
 * functions now live here — engine-private, never re-exported by the façade
 * — and the daemon side shrinks to the narrow capabilities this function
 * drives: routing (`beginTargetVerification`), capture
 * (`captureObservation`), classification (`classifyTarget`), dispatch
 * (`dispatchStep`), and wire-building the resulting divergence
 * (`buildRecordedUnverifiableFailure`, `buildTargetBindingFailure`,
 * `buildPostDispatchTargetBindingFailure`).
 *
 * #1554 fold-in (rebase onto main's `replay --keep-session`): main grew this
 * exact terminal-close-suppression decision independently, daemon-side, as
 * `session-replay-terminal-lifecycle.ts`'s `resolveSuppressedTerminalCloseIndex`
 * / `countExecutedReplayActions`, generalizing the repair-only physical-last-
 * index check this module already had (`isRepairArmedTerminalCloseAction`) to
 * "terminal among EXECUTABLE actions" and adding `--keep-session` as a second
 * reason to suppress. Per the same "pure policy belongs in the engine"
 * boundary this whole module exists to enforce, that generalized resolution
 * — `resolveSuppressedTerminalCloseIndex` below — now lives here instead,
 * unified with (replacing) the old repair-only predicate, and `runAdReplay`
 * folds the resulting `replayed` count in directly rather than a separate
 * daemon-side post-hoc counter. `requireLiveSessionForKeepSession` — the
 * `--keep-session` postcondition that inspects `SessionStore` — stays daemon
 * authority and never moved here.
 *
 * #1555 review P1 (second pass, "move variable semantics/planning behind the
 * replay entrypoint"): `runAdReplay` builds the `${VAR}` scope, via
 * `@agent-device/ad-script`'s `buildReplayVarScope`, from the request's
 * `varSources` — plain data (builtins/file/shell/cli env) the daemon reads
 * from the request/process — and resolves each action EXACTLY ONCE per step
 * (`resolveReplayAction`), before `verifyAndDispatchStep` does anything else
 * with it. The RESOLVED action is what reaches `dispatchStep` and
 * `beginTargetVerification`; every other capability still receives the
 * ORIGINAL recorded `action` (a target-binding divergence reports the
 * recorded selector, never an expanded `${VAR}`). This replaces two
 * independent daemon-side interpolation call sites — dispatch's own
 * (`session-replay-action-runtime.ts`'s `invokeReplayAction`) and target
 * verification's separate one (`session-replay-target-verification.ts`'s
 * `resolveTargetVerificationEntry`) — with this one engine-owned resolution.
 * The engine's own live scope is also the one source for the `${VAR}` values
 * a divergence report may redact (`collectReplayScrubbableVarValues`),
 * threaded to each build-failure/`handleActionFailure` capability as an
 * explicit `scrubVars` argument rather than recomputed daemon-side from a
 * second scope object — the daemon no longer holds a `ReplayVarScope` value
 * at all.
 */

/**
 * `${VAR}` scope inputs — plain data (builtins/file/shell/cli env) the
 * daemon reads from the request/process and passes in; `runAdReplay` builds
 * the scope from this. Derived structurally off `buildReplayVarScope`
 * (`@agent-device/ad-script` does not export its own `ReplayVarSources` type
 * by name) rather than duplicating the shape.
 */
type AdReplayVarSources = Parameters<typeof buildReplayVarScope>[0];

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

/** `executeStep`'s per-dispatch result: pass, or a neutral failure (never a wire response). */
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
   * The selector-port instance this request threads through classification
   * and — as of this pass — the engine's own pre-dispatch verification plan
   * (its recorded-selector parse-check). An engine-owned value (the façade
   * names `ReplaySelectorPort`), never a daemon/wire shape.
   */
  port: ReplaySelectorPort;
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
   * lookup/matching a real dispatch would — daemon authority (tree helpers,
   * the selector port).
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
  /** The recorded selector's display value for progress reporting — needs the private selector AST, daemon-only. */
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
   * close among executable actions (see `resolveSuppressedTerminalCloseIndex`)
   * so the session survives completion instead of tearing down. Unifies with
   * the pre-existing repair-armed terminal-close suppression: both modes
   * share the SAME structural "terminal among executable actions" resolution
   * below, one OR'd into the single suppression check `runAdReplay` makes.
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

/**
 * ADR 0012 step 4's step loop: for every executable action from
 * `request.entryIndex` on, arm the save-script transaction, skip a
 * repair-armed or `--keep-session` plan's terminal `close` (lifecycle, not a
 * script step), report progress, verify-then-dispatch through
 * `verifyAndDispatchStep`, and stop at the first failure. Moved verbatim from
 * `executeReplayActions`'s composition order — only the daemon capabilities
 * it calls through were narrowed into `runtime`.
 *
 * #1554 fold-in: `terminalCloseIndex` is resolved ONCE, structurally, from
 * `actions` alone (independent of which mode wants it suppressed) via
 * `resolveSuppressedTerminalCloseIndex`. Whether it actually gets suppressed
 * THIS run is decided per-step, at the point the loop reaches it: `keepSession`
 * is a static per-run flag, but repair-armed is checked through
 * `runtime.isRepairArmed()` right after `runtime.armStep()` — deliberately
 * dynamic, because a bare `--save-script` first arms the transaction on this
 * very call (`armStep()` mutates the session), so re-reading it here (rather
 * than snapshotting it before the loop) is what lets a first-arm run and a
 * continuing `--from` leg share one check. The suppressed index is excluded
 * from `replayed` exactly like a skipped `replay` pseudo-action — never
 * dispatched, never divergence-checked, never counted.
 */
export async function runAdReplay(
  request: AdReplayRunRequest,
  runtime: AdReplayStepRuntime,
): Promise<AdReplayRunOutcome> {
  const { actions, entryIndex, keepSession } = request;
  // The one `${VAR}` scope this run builds — see the module header. Mutated
  // in place as each step resolves (tracks which builtins actually expanded,
  // for `collectReplayScrubbableVarValues`), never rebuilt mid-run.
  const scope = buildReplayVarScope(request.varSources);
  const artifactPaths = new Set<string>();
  const snapshotDiagnosticSamples: SnapshotTimingSample[] = [];
  const terminalCloseIndex = resolveSuppressedTerminalCloseIndex(actions);
  let replayed = 0;
  for (let index = entryIndex; index < actions.length; index += 1) {
    const action = actions[index];
    if (!isExecutableReplayAction(action)) continue;
    // Arm before checking terminal close so `[open, close]` records the
    // session created by `open` before treating `close` as lifecycle.
    runtime.armStep();
    if (index === terminalCloseIndex && (keepSession || runtime.isRepairArmed())) {
      continue;
    }
    replayed += 1;
    // `onStep?.(x)` short-circuits evaluating `x` when `onStep` is absent
    // (the ordinary `replay` command has no sink) — an explicit guard
    // preserves that: `describeStepValue` must not run needlessly.
    if (runtime.onStep) {
      const value = runtime.describeStepValue(action);
      runtime.onStep(buildAdReplayProgressStep(index, actions.length, action, value));
    }
    // The engine's one resolution of this step's action — see the module
    // header. Every capability below that needs an interpolated value
    // receives THIS value; every other capability still receives `action`.
    const resolvedAction = resolveReplayAction(action, scope, resolveActionLoc(request, index));
    const sampleStart = runtime.diagnosticsMarker();
    const stepOutcome = await verifyAndDispatchStep(runtime, scope, action, resolvedAction, index, [
      ...artifactPaths,
    ]);
    snapshotDiagnosticSamples.push(...runtime.diagnosticsSince(sampleStart));
    if (stepOutcome.status === 'ok') {
      stepOutcome.artifactPaths.forEach((entry) => artifactPaths.add(entry));
      continue;
    }
    stepOutcome.failure.artifactPaths.forEach((entry) => artifactPaths.add(entry));
    const failure = await runtime.handleActionFailure({
      action,
      index,
      artifactPaths: [...artifactPaths],
      snapshotDiagnosticSamples,
      scrubVars: collectReplayScrubbableVarValues(scope),
    });
    return { status: 'failed', stepIndex: index, failure };
  }
  return {
    status: 'completed',
    replayed,
    artifactPaths: [...artifactPaths],
    snapshotDiagnosticSamples,
  };
}

/** `resolveReplayAction`'s `loc` for one step — `actionSourcePaths[index]` when the step came from a `runFlow` include, else the top-level plan's own resolved path. */
function resolveActionLoc(
  request: AdReplayRunRequest,
  index: number,
): { file: string; line: number } {
  return {
    file: request.actionSourcePaths?.[index] ?? request.resolvedPath,
    line: request.actionLines[index] ?? 1,
  };
}

/**
 * The verify-then-dispatch orchestrator: ADR 0012 step 4 verify + dispatch +
 * guard, ENGINE-side as of the #1555 review pass. Mirrors
 * `verifyReplayActionTarget`'s exact branch order (moved verbatim from
 * `session-replay-target-verification.ts`) — only the async daemon-owned
 * pieces (registry/session/wait-form routing, capture, classification,
 * dispatch, wire-building) were narrowed into `runtime` capabilities; the
 * plan/derive DECISIONS (`planPostResolutionTargetVerification`,
 * `planPreDispatchTargetVerification`, `deriveReplayTargetGuardMismatchEvidence`,
 * `deriveWaitLandmarkMismatchEvidence`) are called from here, never from the
 * daemon.
 */
async function verifyAndDispatchStep(
  runtime: AdReplayStepRuntime,
  scope: ReplayVarScope,
  action: SessionAction,
  resolvedAction: SessionAction,
  index: number,
  artifactPaths: readonly string[],
): Promise<AdReplayStepOutcome> {
  const recorded = action.targetEvidence;
  if (!recorded) return dispatchNoGuard(runtime, action, resolvedAction, index, artifactPaths);

  const entry = runtime.beginTargetVerification(action, resolvedAction, index);
  if (entry.kind === 'inactive') {
    return dispatchNoGuard(runtime, action, resolvedAction, index, artifactPaths);
  }

  // #1349 post-resolution phase (`wait`): NEVER the generic pre-dispatch
  // resolution below — an absent landmark is a wait's expected starting
  // condition, so refusing on the current screen would break polling. Only
  // a recorded-`unverifiable` annotation refuses up front; a verifiable
  // landmark is deferred into the wait's own loop.
  if (entry.kind === 'post-resolution') {
    const plan = planPostResolutionTargetVerification({
      recorded,
      isSelectorWait: entry.isSelectorWait,
    });
    switch (plan.kind) {
      case 'skip':
        return dispatchNoGuard(runtime, action, resolvedAction, index, artifactPaths);
      case 'recorded-unverifiable':
        return {
          status: 'failed',
          failure: await runtime.buildRecordedUnverifiableFailure(
            action,
            index,
            artifactPaths,
            collectReplayScrubbableVarValues(scope),
          ),
        };
      case 'deferred-landmark':
        return dispatchWithGuard(runtime, scope, action, resolvedAction, index, artifactPaths, {
          kind: 'landmark',
          landmark: plan.landmark,
        });
    }
  }

  // entry.kind === 'pre-dispatch': the ordinary gate.
  const preDispatchPlan = planPreDispatchTargetVerification({
    recorded,
    token: entry.token,
    platform: entry.platform,
    port: runtime.port,
  });
  if (preDispatchPlan.kind === 'skip') {
    return dispatchNoGuard(runtime, action, resolvedAction, index, artifactPaths);
  }
  if (preDispatchPlan.kind === 'recorded-unverifiable') {
    return {
      status: 'failed',
      failure: await runtime.buildRecordedUnverifiableFailure(
        action,
        index,
        artifactPaths,
        collectReplayScrubbableVarValues(scope),
      ),
    };
  }
  const token = preDispatchPlan.token;

  // #1385: this is the pre-dispatch gate a step right after `open --relaunch`
  // can race — the app may still be launching/mounting when this capture
  // lands. Bounded retry rides out that transition (`retryLaunchRace`).
  const observation = await runtime.captureObservation(action, index, { retryLaunchRace: true });
  if (observation.state !== 'available') {
    return {
      status: 'failed',
      failure: await runtime.buildTargetBindingFailure(
        action,
        index,
        {
          kind: 'identity-unverifiable',
          matchCount: undefined,
          observed: undefined,
          candidateNodes: [],
          mismatches: [],
          causeCode: 'IDENTITY_UNVERIFIABLE',
          causeMessage: `Could not capture a fresh snapshot to verify the recorded target before acting (${observation.reason}).`,
          ...(observation.hint !== undefined ? { causeHint: observation.hint } : {}),
        },
        artifactPaths,
        collectReplayScrubbableVarValues(scope),
      ),
    };
  }

  const classification = runtime.classifyTarget({ action, index, token, nodes: observation.nodes });
  if (classification.verified) {
    return dispatchWithGuard(runtime, scope, action, resolvedAction, index, artifactPaths, {
      kind: 'target',
      guard: classification.guard,
    });
  }
  return {
    status: 'failed',
    failure: await runtime.buildTargetBindingFailure(
      action,
      index,
      {
        kind: classification.kind,
        matchCount: classification.matchCount,
        observed: classification.observed,
        candidateNodes: classification.candidateNodes,
        mismatches: classification.mismatches,
        causeCode: classification.causeCode,
        causeMessage: classification.causeMessage,
      },
      artifactPaths,
      collectReplayScrubbableVarValues(scope),
    ),
  };
}

/** Dispatches with no pre-action guard — nothing to cross-check, so a mismatch marker can never legitimately fire. */
async function dispatchNoGuard(
  runtime: AdReplayStepRuntime,
  action: SessionAction,
  resolvedAction: SessionAction,
  index: number,
  artifactPaths: readonly string[],
): Promise<AdReplayStepOutcome> {
  const outcome = await runtime.dispatchStep(
    action,
    resolvedAction,
    index,
    artifactPaths,
    undefined,
  );
  switch (outcome.status) {
    case 'ok':
      return { status: 'ok', artifactPaths: outcome.artifactPaths };
    case 'failed':
      return { status: 'failed', failure: outcome.failure };
    case 'guard-mismatch':
    case 'landmark-mismatch':
      // `dispatchStep` never reports a mismatch marker without a matching
      // guard to check it against — unreachable in practice; stay total via
      // the plain fallback failure.
      return { status: 'failed', failure: outcome.plainFailure };
  }
}

/**
 * Dispatches carrying a pre-action guard and converts a matching
 * post-resolution refusal marker into its identity-mismatch target-binding
 * divergence, deriving the evidence via the (engine-private) derive
 * functions this pass moved in from the daemon.
 */
async function dispatchWithGuard(
  runtime: AdReplayStepRuntime,
  scope: ReplayVarScope,
  action: SessionAction,
  resolvedAction: SessionAction,
  index: number,
  artifactPaths: readonly string[],
  guard: AdReplayDispatchGuard,
): Promise<AdReplayStepOutcome> {
  const outcome = await runtime.dispatchStep(action, resolvedAction, index, artifactPaths, guard);
  if (outcome.status === 'ok') return { status: 'ok', artifactPaths: outcome.artifactPaths };
  if (outcome.status === 'failed') return { status: 'failed', failure: outcome.failure };

  // The refusal markers are only ever attached to an annotated action; fall
  // back to the plain dispatch failure if the invariant is somehow violated.
  const recorded = action.targetEvidence;
  if (!recorded) return { status: 'failed', failure: outcome.plainFailure };

  const evidence =
    outcome.status === 'guard-mismatch'
      ? deriveReplayTargetGuardMismatchEvidence(
          recorded,
          outcome.evidence,
          guard.kind === 'target' ? guard.guard.matchCount : 0,
        )
      : deriveWaitLandmarkMismatchEvidence(recorded, outcome.evidence);

  return {
    status: 'failed',
    failure: await runtime.buildPostDispatchTargetBindingFailure(
      action,
      index,
      {
        kind: 'identity-mismatch',
        matchCount: evidence.matchCount,
        observed: evidence.observed,
        candidateNodes: [],
        mismatches: evidence.mismatches,
        causeCode: 'IDENTITY_MISMATCH',
        causeMessage: evidence.causeMessage,
      },
      artifactPaths,
      collectReplayScrubbableVarValues(scope),
    ),
  };
}

/**
 * ADR 0012 decision 6 (Fix 3): a nested `replay` line in an `.ad` file is
 * lifecycle-skipped, never dispatched or expanded (native `.ad` has no
 * include grammar).
 */
export function isExecutableReplayAction(
  action: SessionAction | undefined,
): action is SessionAction {
  return Boolean(action && action.command !== 'replay');
}

/**
 * ADR 0012 decision 6 (Fix 3) + #1554: resolves the ONE native replay
 * lifecycle seam a plan can have — its terminal `close` AMONG EXECUTABLE
 * actions, because a trailing `replay "./nested.ad"` line is plan metadata
 * (`isExecutableReplayAction` already skips it) and never dispatches, so the
 * true terminal step can sit before the array's physical last index. Callers
 * (`runAdReplay`) still decide WHETHER this seam is actually suppressed this
 * run — repair-armed or `--keep-session` — this function only says WHERE it
 * is, structurally, independent of either mode.
 *
 * Both suppression reasons share this one resolution because they are the
 * same decision family: replaying the recorded `close` here would dispatch it
 * as an ordinary step — tearing the session down (and, for repair, absent Fix
 * 1/2, even publishing or diverging) before the agent/caller gets the chance
 * `close --save-script` (repair) or continued interactive use (`--keep-session`)
 * depends on. The suppressed close is therefore neither divergence-checked
 * nor included in the successful `replayed` count, exactly like the `replay`
 * pseudo-command just above it in the loop.
 */
export function resolveSuppressedTerminalCloseIndex(
  actions: readonly SessionAction[],
): number | undefined {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index];
    if (!isExecutableReplayAction(action)) continue;
    return action.command === 'close' ? index : undefined;
  }
  return undefined;
}

function buildAdReplayProgressStep(
  actionIndex: number,
  actionTotal: number,
  action: SessionAction,
  value: string | undefined,
): AdReplayProgressStep {
  return {
    index: actionIndex + 1,
    total: actionTotal,
    command: action.command,
    ...(value !== undefined ? { value } : {}),
  };
}
