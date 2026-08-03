import type { DaemonRequest, DaemonResponse, SessionAction } from '../types.ts';
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
import {
  asFailedReplayStepResponse,
  buildReplayActionFailure,
  describeReplayStepValue,
  readSessionSnapshotSampleCount,
  readSessionSnapshotSamplesSince,
  type ReplayStepContext,
} from './session-replay-runtime-step-support.ts';
import type { ReplayTestAttemptStepSink } from '@agent-device/replay-test';

/**
 * #1555 P5 (decomposition): the daemon's `AdReplayStepRuntime` adapter — extracted verbatim out
 * of `session-replay-runtime.ts`, which now only constructs a `ReplayStepContext` and calls
 * `createAdReplayStepRuntime`. See that file's `runReplayScriptFile` for the request-level
 * orchestration this adapter plugs into.
 *
 * #1555 structural-quality review ("shrink the runtime adapter toward the
 * plan's <300 LOC metric"): the wire-narrowing concern (guard threading,
 * `details` bag -> typed evidence, dispatch-failure classification) moved to
 * `session-replay-dispatch-narrowing.ts`; `ReplayStepContext` and the
 * failure-wrapping/diagnostics support helpers moved to
 * `session-replay-runtime-step-support.ts` (re-exporting `ReplayStepContext`
 * by name so this file's own importers see no path change). This file is
 * left with exactly the `createAdReplayStepRuntime` factory and the small
 * closures only it needs.
 */
export type { ReplayStepContext } from './session-replay-runtime-step-support.ts';

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
