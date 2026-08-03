import type { DaemonInvokeFn, DaemonRequest, DaemonResponse, SessionAction } from '../types.ts';
import type { SessionStore } from '../session-store.ts';
import { errorResponse } from './response.ts';
import { invokeReplayAction } from './session-replay-action-runtime.ts';
import { readReplaySelectorDisplayValue } from '../replay-selector-port.ts';
import type { ResponseLevel } from '@agent-device/kernel/contracts';
import type {
  AdReplayStepFailure,
  AdReplayStepRuntime,
  ReplaySelectorPort,
} from '../ad-replay-facade-types.ts';
import type { LocalIdentity } from '@agent-device/ad-script';
import type { SnapshotTimingSample } from '@agent-device/contracts/capture';
import type { TargetAncestryEntry } from '@agent-device/contracts/replay';
import { collectReplayActionArtifactPaths } from './session-replay-runtime-artifacts.ts';
import { withReplayFailureDiagnostics } from './session-replay-runtime-failure.ts';
import {
  captureDivergenceObservation,
  type DivergenceObservation,
} from './session-replay-divergence.ts';
import {
  buildPostDispatchTargetBindingFailureResponse,
  buildRecordedUnverifiableFailureResponse,
  buildTargetBindingFailureResponse,
  classifyPreDispatchTarget,
  isReplayTargetGuardMismatchResponse,
  isWaitLandmarkMismatchResponse,
  resolveTargetVerificationEntry,
  type TargetBindingDivergenceContext,
  type TargetBindingFailureEvidence,
} from './session-replay-target-verification.ts';
import type { ReplayTestAttemptStepSink } from '@agent-device/replay-test';
import type { ReplayCoordinator } from '../session-replay-coordinator.ts';

/**
 * #1555 P5 (decomposition): the daemon's `AdReplayStepRuntime` adapter — extracted verbatim out
 * of `session-replay-runtime.ts`, which now only constructs a `ReplayStepContext` and calls
 * `createAdReplayStepRuntime`. See that file's `runReplayScriptFile` for the request-level
 * orchestration this adapter plugs into.
 */

/**
 * Per-run invariants for a single replay step (ADR 0012 step 4 verify +
 * dispatch + guard). No `${VAR}` scope here (#1555 review P1, "move variable
 * semantics/planning behind the replay entrypoint") — the engine
 * (`runAdReplay`) builds and owns it; this adapter never resolves an action
 * or reads a scope value itself.
 */
export type ReplayStepContext = {
  replayReq: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  logPath: string;
  resolved: string;
  actions: SessionAction[];
  actionLines: number[];
  actionSourcePaths: (string | undefined)[] | undefined;
  planDigest: string;
  actionTracePath: string | undefined;
  responseLevel: ResponseLevel | undefined;
  invoke: DaemonInvokeFn;
  signal: AbortSignal | undefined;
  /** #1478 P4b: the one locked gateway to this request's repair transaction. */
  coordinator: ReplayCoordinator;
  /** #1478 P5 stage C: the one selector-port instance this request threads through the divergence-report chain. */
  port: ReplaySelectorPort;
};

/**
 * The engine's evidence-bag type for `buildTargetBindingFailure`/
 * `buildPostDispatchTargetBindingFailure`, read off `AdReplayStepRuntime`
 * itself (`Parameters<...>`) rather than a named façade export — the R3 pass
 * deliberately did not add `AdReplayTargetBindingEvidence` to
 * `@agent-device/ad-replay`'s export list, so this is how a daemon helper
 * still gets a precise parameter type without widening the façade.
 */
type EngineTargetBindingEvidence = Parameters<AdReplayStepRuntime['buildTargetBindingFailure']>[2];

/** Converts the engine's (readonly-array) evidence shape to this module's own mutable-array `TargetBindingFailureEvidence`. */
function toDaemonEvidence(evidence: EngineTargetBindingEvidence): TargetBindingFailureEvidence {
  return {
    kind: evidence.kind,
    matchCount: evidence.matchCount,
    observed: evidence.observed,
    candidateNodes: [...evidence.candidateNodes],
    mismatches: [...evidence.mismatches],
    causeCode: evidence.causeCode,
    causeMessage: evidence.causeMessage,
    ...(evidence.causeHint !== undefined ? { causeHint: evidence.causeHint } : {}),
  };
}

/** The engine's pre-action identity guard, read off `AdReplayStepRuntime` itself (see `EngineTargetBindingEvidence` above for why `Parameters<...>` rather than a named façade export). */
type ReplayDispatchGuard = Parameters<AdReplayStepRuntime['dispatchStep']>[4];

/** `dispatchStep`'s result shape, read off `AdReplayStepRuntime` itself for the same reason. */
type ReplayDispatchOutcome = Awaited<ReturnType<AdReplayStepRuntime['dispatchStep']>>;

/**
 * The two post-resolution refusal markers' typed evidence shapes, read off
 * `ReplayDispatchOutcome` itself — the SAME `Parameters<...>`/`Extract<...>`
 * idiom as `ReplayDispatchGuard`/`EngineTargetBindingEvidence` above, rather
 * than a named façade export.
 */
type ReplayGuardMismatchEvidence = Extract<
  ReplayDispatchOutcome,
  { status: 'guard-mismatch' }
>['evidence'];
type ReplayLandmarkMismatchEvidence = Extract<
  ReplayDispatchOutcome,
  { status: 'landmark-mismatch' }
>['evidence'];

/** Threads a pre-action identity guard into the request's `internal` block the interaction layer reads for its own resolution — a no-op when no guard applies. */
function applyReplayDispatchGuard(
  replayReq: DaemonRequest,
  guard: ReplayDispatchGuard,
): DaemonRequest {
  const guardInternal =
    guard?.kind === 'target'
      ? { replayTargetGuard: guard.guard.expected }
      : guard?.kind === 'landmark'
        ? { replayLandmarkGuard: guard.landmark }
        : undefined;
  return guardInternal
    ? { ...replayReq, internal: { ...replayReq.internal, ...guardInternal } }
    : replayReq;
}

/**
 * #1555 review P1 (second pass, "translate wire failures before the engine
 * boundary"): the wire response's `details: Record<string, unknown> | undefined`
 * bag is read HERE, at the adapter — the one place a real `DaemonResponse`
 * exists — and narrowed into the engine's typed evidence shapes before
 * `classifyReplayDispatchFailure` returns. `deriveReplayTargetGuardMismatchEvidence`/
 * `deriveWaitLandmarkMismatchEvidence` (`@agent-device/ad-replay`'s engine-
 * private `target-verification.ts`) consume only these typed values now —
 * the `unknown`-parsing readers that used to live in the package (reading
 * `details.observed`/`details.expectedStructural`/`details.observedStructural`/
 * `details.observedAncestry`/`details.matchCount` defensively) moved here
 * with the wire-reading responsibility they always were.
 */
function readGuardMismatchObservedIdentity(value: unknown): LocalIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.role !== 'string') return undefined;
  return {
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    role: record.role,
    ...(typeof record.label === 'string' ? { label: record.label } : {}),
  };
}

/** The wait refusal's `observedAncestry` entries, defensively re-read off error details. */
function readAncestryEntries(value: unknown): TargetAncestryEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: TargetAncestryEntry[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.role !== 'string') return [];
    entries.push({
      role: record.role,
      ...(typeof record.label === 'string' ? { label: record.label } : {}),
    });
  }
  return entries;
}

/** A structural denotation (`{documentOrder, sibling}`), defensively re-read off error details. */
function readTargetStructuralDenotation(
  value: unknown,
): { documentOrder: number; sibling: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.documentOrder !== 'number' || typeof record.sibling !== 'number') {
    return undefined;
  }
  return { documentOrder: record.documentOrder, sibling: record.sibling };
}

function readGuardMismatchEvidence(
  details: Record<string, unknown> | undefined,
): ReplayGuardMismatchEvidence {
  return {
    observed: readGuardMismatchObservedIdentity(details?.observed),
    expectedStructural: readTargetStructuralDenotation(details?.expectedStructural),
    observedStructural: readTargetStructuralDenotation(details?.observedStructural),
  };
}

function readLandmarkMismatchEvidence(
  details: Record<string, unknown> | undefined,
): ReplayLandmarkMismatchEvidence {
  return {
    matchCount: typeof details?.matchCount === 'number' ? details.matchCount : undefined,
    observed: readGuardMismatchObservedIdentity(details?.observed),
    observedAncestry: readAncestryEntries(details?.observedAncestry),
  };
}

/** Classifies a failed dispatch response into an ordinary failure or one of the two post-resolution identity-refusal markers (`guard-mismatch`/`landmark-mismatch`) `dispatchStep` detects. */
function classifyReplayDispatchFailure(
  response: Extract<DaemonResponse, { ok: false }>,
  guard: ReplayDispatchGuard,
  entries: readonly string[],
): ReplayDispatchOutcome {
  const plainFailure = toAdReplayStepFailure(response, entries);
  if (guard?.kind === 'target' && isReplayTargetGuardMismatchResponse(response)) {
    return {
      status: 'guard-mismatch',
      evidence: readGuardMismatchEvidence(response.error.details),
      plainFailure,
      artifactPaths: entries,
    };
  }
  if (guard?.kind === 'landmark' && isWaitLandmarkMismatchResponse(response)) {
    return {
      status: 'landmark-mismatch',
      evidence: readLandmarkMismatchEvidence(response.error.details),
      plainFailure,
      artifactPaths: entries,
    };
  }
  return { status: 'failed', failure: plainFailure };
}

/**
 * #1478 P5 stage C2b (narrowed further by the #1555 review's neutral-outcomes
 * pass, then again by the R3 pass that moved verify-then-dispatch into the
 * engine): the daemon's `AdReplayStepRuntime` adapter — the narrow
 * routing/capture/classify/dispatch/build-failure capability bag
 * `runAdReplay`'s step loop threads through. Every member closes over this
 * one request's `ReplayStepContext` (or the outer accumulators it needs to
 * keep in sync); none of it is reachable from the engine except through these
 * functions — the engine drives WHEN each one is called and, for the four
 * target-verification policy decisions, WHAT it means; this adapter only
 * knows HOW to do each daemon-owned piece.
 *
 * `lastResponse` is the side-map the neutral-outcomes design relies on: the
 * ONLY place a real `DaemonResponse` is built or held. Every capability that
 * can end a step (`dispatchStep`, the three `build*Failure` capabilities, and
 * `handleActionFailure`) records the wire response it just built here before
 * projecting it down to the neutral `AdReplayStepOutcome`/`AdReplayStepFailure`
 * the engine actually sees; `readLastResponse` lets `runReplayScriptFile`
 * recover the exact final response once `runAdReplay` reports which step
 * failed, so the client-visible wire output never changes even though the
 * engine itself never touches it.
 *
 * `lastObservation` is the analogous side-map for `buildTargetBindingFailure`
 * — it reuses the SAME capture `captureObservation` just took (for its
 * `screen`), mirroring the pre-R3 code's single-capture-serves-both-paths
 * invariant instead of taking a second, possibly-different snapshot.
 */
export function createAdReplayStepRuntime(params: {
  ctx: ReplayStepContext;
  req: DaemonRequest;
  /** The outer exception-reporting mirror (see `runReplayScriptFile`'s catch block). */
  artifactPaths: Set<string>;
  onStep: ReplayTestAttemptStepSink | undefined;
  armSaveScript: () => void;
}): { runtime: AdReplayStepRuntime; readLastResponse: () => DaemonResponse | undefined } {
  const { ctx, req, artifactPaths, onStep, armSaveScript } = params;
  let lastResponse: DaemonResponse | undefined;
  let lastObservation: DivergenceObservation | undefined;

  /**
   * The `TargetBindingDivergenceContext` every wire-builder needs — built
   * fresh per call from `action`/`index`/its own `artifactPaths` snapshot.
   * `scrubVars` is the engine's own live `${VAR}` scrub list as of this
   * point in the run, threaded in by the caller rather than recomputed here
   * from a scope this adapter no longer holds.
   */
  const buildDivergenceContext = (
    action: SessionAction,
    index: number,
    stepArtifactPaths: readonly string[],
    scrubVars: TargetBindingDivergenceContext['scrubVars'],
  ): TargetBindingDivergenceContext => ({
    // Only ever called on a path that confirmed `action.targetEvidence` is
    // present (the engine checks that before calling anything else).
    recorded: action.targetEvidence!,
    action,
    step: index + 1,
    sourcePath: ctx.actionSourcePaths?.[index] ?? ctx.resolved,
    sourceLine: ctx.actionLines[index] ?? 1,
    replayPath: ctx.resolved,
    artifactPaths: [...stepArtifactPaths],
    sessionName: ctx.sessionName,
    sessionStore: ctx.sessionStore,
    resumeStamper: ctx.coordinator.resumeStamper,
    responseLevel: ctx.responseLevel,
    scrubVars,
    planActions: ctx.actions,
    planDigest: ctx.planDigest,
    signal: ctx.signal,
  });

  /** Records `response` in the side-map and projects it down to the neutral failure shape. */
  const recordFailure = (response: DaemonResponse): AdReplayStepFailure => {
    lastResponse = response;
    return toAdReplayStepFailure(
      asFailedReplayStepResponse(response),
      collectReplayActionArtifactPaths(response),
    );
  };

  const runtime: AdReplayStepRuntime = {
    port: ctx.port,

    beginTargetVerification(action, resolvedAction, _index) {
      return resolveTargetVerificationEntry({
        action,
        resolvedAction,
        sessionName: ctx.sessionName,
        sessionStore: ctx.sessionStore,
        port: ctx.port,
      });
    },

    async captureObservation(action, _index, options) {
      const session = ctx.sessionStore.get(ctx.sessionName);
      // #1385: this is the pre-dispatch gate a step right after `open
      // --relaunch` can race — the app may still be launching/mounting when
      // this capture lands, producing a transient `capture-failed` /
      // `sparse-snapshot` verdict that is not a real divergence. Bounded
      // retry (`retryLaunchRace`, engine-driven) rides out that transition
      // instead of failing closed on the first unlucky capture.
      const observation: DivergenceObservation = session
        ? await captureDivergenceObservation({
            session,
            sessionName: ctx.sessionName,
            sessionStore: ctx.sessionStore,
            logPath: ctx.logPath,
            action,
            retryLaunchRace: options.retryLaunchRace,
          })
        : {
            state: 'unavailable',
            reason: 'no-session',
            hint: 'The session closed before a screen could be captured to verify the recorded target.',
          };
      lastObservation = observation;
      return observation.state === 'available'
        ? { state: 'available', nodes: observation.nodes }
        : { state: 'unavailable', reason: observation.reason, hint: observation.hint };
    },

    classifyTarget({ action, token, nodes }) {
      const session = ctx.sessionStore.get(ctx.sessionName);
      return classifyPreDispatchTarget({
        // Only ever called right after a successful `captureObservation`,
        // which itself only reaches `state: 'available'` when a session is
        // active — `action.targetEvidence`/`session` are always defined here
        // in practice.
        recorded: action.targetEvidence!,
        token,
        action,
        nodes: [...nodes],
        platform: session!.device.platform,
        port: ctx.port,
      });
    },

    // `_stepArtifactPaths` (the pre-step snapshot) is unused here — dispatch
    // never fed it to `invokeReplayAction`, even before this split; it only
    // ever reached the target-binding wire builders (`build*Failure` below).
    async dispatchStep(action, resolvedAction, index, _stepArtifactPaths, guard) {
      const sourceLine = ctx.actionLines[index] ?? 1;
      const response = await invokeReplayAction({
        req: applyReplayDispatchGuard(ctx.replayReq, guard),
        sessionName: ctx.sessionName,
        action,
        resolved: resolvedAction,
        filePath: ctx.resolved,
        line: sourceLine,
        sourcePath: ctx.actionSourcePaths?.[index],
        step: index + 1,
        tracePath: ctx.actionTracePath,
        invoke: ctx.invoke,
      });
      lastResponse = response;
      const entries = collectReplayActionArtifactPaths(response);
      entries.forEach((entry) => artifactPaths.add(entry));
      if (response.ok) return { status: 'ok', artifactPaths: entries };
      return classifyReplayDispatchFailure(response, guard, entries);
    },

    async buildRecordedUnverifiableFailure(action, index, stepArtifactPaths, scrubVars) {
      const response = await buildRecordedUnverifiableFailureResponse(
        buildDivergenceContext(action, index, stepArtifactPaths, [...scrubVars]),
        {
          session: ctx.sessionStore.get(ctx.sessionName),
          sessionName: ctx.sessionName,
          sessionStore: ctx.sessionStore,
          logPath: ctx.logPath,
          action,
        },
      );
      return recordFailure(response);
    },

    async buildTargetBindingFailure(action, index, evidence, stepArtifactPaths, scrubVars) {
      const observation: DivergenceObservation = lastObservation ?? {
        state: 'unavailable',
        reason: 'observation-missing',
        hint: 'No capture was recorded before this target-binding failure.',
      };
      const response = buildTargetBindingFailureResponse(
        buildDivergenceContext(action, index, stepArtifactPaths, [...scrubVars]),
        toDaemonEvidence(evidence),
        observation,
      );
      return recordFailure(response);
    },

    async buildPostDispatchTargetBindingFailure(
      action,
      index,
      evidence,
      stepArtifactPaths,
      scrubVars,
    ) {
      const response = await buildPostDispatchTargetBindingFailureResponse(
        buildDivergenceContext(action, index, stepArtifactPaths, [...scrubVars]),
        toDaemonEvidence(evidence),
        {
          session: ctx.sessionStore.get(ctx.sessionName),
          sessionName: ctx.sessionName,
          sessionStore: ctx.sessionStore,
          logPath: ctx.logPath,
          action,
        },
      );
      return recordFailure(response);
    },

    async handleActionFailure({
      action,
      index,
      artifactPaths: failureArtifactPaths,
      snapshotDiagnosticSamples,
      scrubVars,
    }) {
      const failedResponse = asFailedReplayStepResponse(lastResponse);
      const finalResponse = await buildReplayActionFailure(
        ctx,
        req,
        action,
        index,
        failedResponse,
        [...failureArtifactPaths],
        [...snapshotDiagnosticSamples],
        [...scrubVars],
      );
      // `buildReplayActionFailure` is typed `Promise<DaemonResponse>` (it
      // shares its return type with the ordinary success path elsewhere in
      // this module) but always produces a failed response on this call
      // path — it exists to WRAP a failure with diagnostics/repair-hold
      // marking, never to turn one into a success.
      return recordFailure(finalResponse);
    },
    armStep: armSaveScript,
    isRepairArmed: () => ctx.coordinator.view()?.repairBoundary !== undefined,
    describeStepValue: (action) => describeReplayStepValue(action),
    onStep,
    diagnosticsMarker: () => readSessionSnapshotSampleCount(ctx.sessionStore, ctx.sessionName),
    diagnosticsSince: (marker) =>
      readSessionSnapshotSamplesSince(ctx.sessionStore, ctx.sessionName, marker),
  };
  return { runtime, readLastResponse: () => lastResponse };
}

/**
 * `runAdReplay` only ever calls `handleActionFailure` right after
 * `executeStep` reported `status: 'failed'`, and `executeStep` always sets
 * `lastResponse` to that same failed response before returning — so this
 * narrowing cannot actually fail in practice. The `COMMAND_FAILED` fallback
 * exists only so `buildReplayActionFailure` (which needs a real failed
 * response to wrap) stays total if that invariant is ever violated.
 */
function asFailedReplayStepResponse(
  response: DaemonResponse | undefined,
): Extract<DaemonResponse, { ok: false }> {
  if (response && !response.ok) return response;
  return errorResponse(
    'COMMAND_FAILED',
    'replay step reported failure with no recorded response',
  ) as Extract<DaemonResponse, { ok: false }>;
}

/** Projects a wire response down to the neutral shape the engine's outcome carries. */
function toAdReplayStepFailure(
  response: Extract<DaemonResponse, { ok: false }>,
  artifactPaths: readonly string[],
): AdReplayStepFailure {
  return { kind: response.error.code, message: response.error.message, artifactPaths };
}

async function buildReplayActionFailure(
  ctx: ReplayStepContext,
  req: DaemonRequest,
  action: SessionAction,
  index: number,
  response: Extract<DaemonResponse, { ok: false }>,
  artifactPaths: string[],
  snapshotDiagnosticSamples: SnapshotTimingSample[],
  scrubVars: TargetBindingDivergenceContext['scrubVars'],
): Promise<DaemonResponse> {
  const heldResponse = (failure: DaemonResponse): DaemonResponse =>
    ctx.coordinator.markSessionHeldIfArmed(failure);
  if (isCompleteTargetBindingDivergenceResponse(response)) return heldResponse(response);
  return heldResponse(
    await withReplayFailureDiagnostics({
      response,
      action,
      index,
      replayPath: ctx.resolved,
      sourcePath: ctx.actionSourcePaths?.[index] ?? ctx.resolved,
      sourceLine: ctx.actionLines[index] ?? 1,
      artifactPaths,
      snapshotDiagnosticSamples,
      scrubVars,
      req,
      sessionName: ctx.sessionName,
      sessionStore: ctx.sessionStore,
      resumeStamper: ctx.coordinator.resumeStamper,
      logPath: ctx.logPath,
      planActions: ctx.actions,
      planDigest: ctx.planDigest,
      port: ctx.port,
    }),
  );
}

/**
 * A replay-test progress step's display value: the recorded selector's
 * label/text/id term value when every alternative agrees on ONE value, else
 * `undefined`. Needs `readReplaySelectorDisplayValue`'s private selector AST
 * (`replay-selector-port.ts` deliberately keeps it daemon-only — see that
 * file's own comment), so this stays daemon-side and is handed to the engine
 * loop as the narrow `describeStepValue` capability.
 */
function describeReplayStepValue(action: SessionAction): string | undefined {
  const positionals = action.positionals ?? [];
  const selectorValue = readReplaySelectorDisplayValue(positionals[0]);
  if (selectorValue) return selectorValue;
  if (positionals.length === 0) return undefined;
  return positionals.join(' ');
}

// ADR 0012 step 4: a target-binding divergence is already a complete, final
// REPLAY_DIVERGENCE built from its own pre-action capture — distinguished from
// an action-failure divergence by its non-`action-failure` kind. Pinned
// daemon-side: it re-inspects the already-projected `DaemonResponse` wire
// shape to decide whether the wire-level diagnostics-augmentation step
// applies, which is daemon/wire authority, not engine divergence-kind
// classification (that already happened engine-side, in
// `classifyReplayTarget`/`target-identity.ts`).
function isCompleteTargetBindingDivergenceResponse(response: DaemonResponse): boolean {
  if (response.ok || response.error.code !== 'REPLAY_DIVERGENCE') return false;
  const divergence = response.error.details?.divergence;
  const kind =
    divergence && typeof divergence === 'object'
      ? (divergence as Record<string, unknown>).kind
      : undefined;
  return typeof kind === 'string' && kind !== 'action-failure';
}

function readSessionSnapshotSampleCount(sessionStore: SessionStore, sessionName: string): number {
  return sessionStore.get(sessionName)?.snapshotDiagnostics?.samples.length ?? 0;
}

function readSessionSnapshotSamplesSince(
  sessionStore: SessionStore,
  sessionName: string,
  start: number,
): SnapshotTimingSample[] {
  return sessionStore.get(sessionName)?.snapshotDiagnostics?.samples.slice(start) ?? [];
}
