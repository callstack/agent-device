import type { SessionAction } from '@agent-device/contracts/session';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from '../types.ts';
import type { SessionStore } from '../session-store.ts';
import { errorResponse } from './response.ts';
import { readReplaySelectorDisplayValue } from '@agent-device/selectors';
import type { ResponseLevel } from '@agent-device/kernel/contracts';
import type { SnapshotTimingSample } from '@agent-device/contracts/capture';
import { withReplayFailureDiagnostics } from './session-replay-runtime-failure.ts';
import type { ReplayCoordinator } from '../session-replay-coordinator.ts';
import { invokeReplayAction } from './session-replay-action-runtime.ts';
import type { AdReplayStepFailure, AdReplayStepRuntime } from '@agent-device/ad-replay';
import { collectReplayActionArtifactPaths } from './session-replay-runtime-artifacts.ts';
import {
  applyReplayDispatchGuard,
  classifyReplayDispatchFailure,
  toAdReplayStepFailure,
} from './session-replay-dispatch-narrowing.ts';
import {
  captureDivergenceObservation,
  type DivergenceObservation,
} from './session-replay-divergence.ts';
import {
  buildPostDispatchTargetBindingFailureResponse,
  buildRecordedUnverifiableFailureResponse,
  buildTargetBindingFailureResponse,
  classifyPreDispatchTarget,
  resolveTargetVerificationEntry,
  type TargetBindingDivergenceContext,
} from './session-replay-target-verification.ts';
import type { ReplayTestAttemptStepSink } from '@agent-device/replay-test';

/**
 * #1555 P5 (decomposition): the daemon's `AdReplayStepRuntime` adapter — extracted verbatim out
 * of `session-replay-runtime.ts`, which now only constructs a `ReplayStepContext` and calls
 * `createAdReplayStepRuntime`. See that file's `runReplayScriptFile` for the request-level
 * orchestration this adapter plugs into.
 *
 * The wire-narrowing concern (guard threading, `details` bag -> typed
 * evidence, dispatch-failure classification) lives in
 * `session-replay-dispatch-narrowing.ts` — a real seam with one nameable job.
 * Everything else the factory's capabilities delegate to (the step context
 * shape, failure wrapping, progress display, diagnostics sampling) lives
 * below in this file: a briefly-extracted `-step-support` module was folded
 * back after review judged it a size-target fragment, not a concern boundary
 * — this adapter's honest size is ~430 lines, renegotiated from the plan's
 * <300 metric on #1478.
 */

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
 *
 * #1555 structural-quality review ("fix lastObservation to be genuinely
 * per-step"): both this closure and `armStep` live for the whole RUN (one
 * `createAdReplayStepRuntime` call covers every step), so an un-reset
 * `lastObservation` would silently carry a PREVIOUS step's capture into a
 * step that somehow reached `buildTargetBindingFailure` without its own
 * `captureObservation` call first — the `?? { reason: 'observation-missing'
 * }` fallback below exists to name that condition, but could never actually
 * fire for it; it would instead attach a stale, wrong-step screen. `armStep`
 * runs exactly once per step, before any of this step's capabilities do —
 * clearing `lastObservation` there makes the fallback message correct for
 * ANY future call ordering, not just the current one where every
 * `buildTargetBindingFailure` call site happens to be preceded by this same
 * step's own `captureObservation`.
 */
export function createAdReplayStepRuntime(params: {
  ctx: ReplayStepContext;
  req: DaemonRequest;
  /**
   * The run's ONE artifact ledger, owned by `runReplayScriptFile`. `dispatchStep`
   * is its only writer, and returns its contents for the engine to thread as a
   * plain value — the engine keeps no accumulator of its own (#1478 P5
   * follow-up; see `@agent-device/ad-replay`'s `step-loop.ts` header). Also what
   * `runReplayScriptFile`'s catch block reports, so a mid-loop throw still names
   * the artifacts collected up to that point.
   */
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
    beginTargetVerification(action, resolvedAction, _index, targetRole) {
      return resolveTargetVerificationEntry({
        action,
        resolvedAction,
        sessionName: ctx.sessionName,
        sessionStore: ctx.sessionStore,
        targetRole,
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
      // The run's one artifact ledger: this step's entries are written into
      // it here, and its CONTENTS (not just this step's entries) are what the
      // engine gets back to thread as its own `artifactPaths` value — see
      // `createAdReplayStepRuntime`'s `artifactPaths` parameter.
      collectReplayActionArtifactPaths(response).forEach((entry) => artifactPaths.add(entry));
      const ledger = [...artifactPaths];
      if (response.ok) return { status: 'ok', artifactPaths: ledger };
      return classifyReplayDispatchFailure(response, guard, ledger);
    },

    async buildRecordedUnverifiableFailure(action, index, stepArtifactPaths, scrubVars) {
      const response = await buildRecordedUnverifiableFailureResponse(
        buildDivergenceContext(action, index, stepArtifactPaths, scrubVars),
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
        buildDivergenceContext(action, index, stepArtifactPaths, scrubVars),
        evidence,
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
        buildDivergenceContext(action, index, stepArtifactPaths, scrubVars),
        evidence,
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
        scrubVars,
      );
      // `buildReplayActionFailure` is typed `Promise<DaemonResponse>` (it
      // shares its return type with the ordinary success path elsewhere in
      // this module) but always produces a failed response on this call
      // path — it exists to WRAP a failure with diagnostics/repair-hold
      // marking, never to turn one into a success.
      return recordFailure(finalResponse);
    },
    armStep: () => {
      // Runs exactly once per step, before any of this step's other
      // capabilities — the natural per-step boundary to clear the previous
      // step's capture (see this factory's own header).
      lastObservation = undefined;
      armSaveScript();
    },
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
 * Per-run invariants for a single replay step (ADR 0012 step 4 verify +
 * dispatch + guard). No `${VAR}` scope here (#1555 review P1, "move variable
 * semantics/planning behind the replay entrypoint") — the engine
 * (`runAdReplay`) builds and owns it; the adapter never resolves an action
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
};

/**
 * `runAdReplay` only ever calls `handleActionFailure` right after a step's
 * dispatch/build-failure capability reported `status: 'failed'`, and every
 * one of those capabilities records its response in the adapter's
 * `lastResponse` side-map before returning — so this narrowing cannot
 * actually fail in practice. The `COMMAND_FAILED` fallback exists only so
 * `buildReplayActionFailure` (which needs a real failed response to wrap)
 * stays total if that invariant is ever violated.
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
    }),
  );
}

/**
 * A replay-test progress step's display value: the recorded selector's
 * label/text/id term value when every alternative agrees on ONE value, else
 * `undefined`. `readReplaySelectorDisplayValue` keeps the selector AST inside
 * `@agent-device/selectors`; this stays daemon-side and is handed to the
 * engine loop as the narrow `describeStepValue` capability.
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
// applies, which is daemon/wire authority, not target-binding classification
// itself (that already happened, in `session-replay-target-classification.ts`'s
// `classifyReplayTarget`, called from `classifyPreDispatchTarget`).
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
