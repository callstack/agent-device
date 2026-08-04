import type { SessionAction } from '@agent-device/contracts/session';
import {
  deriveReplayTargetGuardMismatchEvidence,
  deriveWaitLandmarkMismatchEvidence,
  planPostResolutionTargetVerification,
  planPreDispatchTargetVerification,
} from './target-verification.ts';
import type {
  AdReplayDispatchGuard,
  AdReplayScrubValue,
  AdReplayStepOutcome,
  AdReplayStepRuntime,
} from './runtime-port-types.ts';

/**
 * #1478 P5 stage C2b (split out of `step-loop.ts` by the #1555 structural-
 * quality review, "split step-loop.ts per the maestro precedent it cites"):
 * `verifyAndDispatchStep` — the verify-then-dispatch orchestrator that used
 * to live daemon-side (`session-replay-target-verification.ts`'s
 * `verifyReplayActionTarget` / `convertIdentityRefusalResponse`) calling OUT
 * to `./target-verification.ts`'s four policy functions. The call sites for
 * those four functions live here — engine-private, never re-exported by the
 * façade — and the daemon side is the narrow `AdReplayStepRuntime`
 * capabilities this function drives: routing (`beginTargetVerification`),
 * capture (`captureObservation`), classification (`classifyTarget`),
 * dispatch (`dispatchStep`), and wire-building the resulting divergence
 * (`buildRecordedUnverifiableFailure`, `buildTargetBindingFailure`,
 * `buildPostDispatchTargetBindingFailure`). `./step-loop.ts`'s `runAdReplay`
 * is this module's one caller.
 *
 * #1555 structural-quality review ("scrub values — one name, compute
 * collectReplayScrubbableVarValues(scope) once, thread the value, delete
 * per-call recomputation"): this module used to take the run's live
 * `ReplayVarScope` and call `collectReplayScrubbableVarValues(scope)` fresh
 * at each of five separate return points within one step — always the SAME
 * result, since nothing in this module's own flow mutates the scope
 * (`resolveReplayAction`, the run's one scope-expanding call, already ran
 * before `./step-loop.ts` calls in here). `runAdReplay` now computes
 * `scrubVars` ONCE per step, right after resolving the step's action, and
 * threads it down as a plain value — this module never imports
 * `ReplayVarScope` or `collectReplayScrubbableVarValues` at all.
 */
export async function verifyAndDispatchStep(
  runtime: AdReplayStepRuntime,
  scrubVars: readonly AdReplayScrubValue[],
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
            scrubVars,
          ),
        };
      case 'deferred-landmark':
        return dispatchWithGuard(runtime, scrubVars, action, resolvedAction, index, artifactPaths, {
          kind: 'landmark',
          landmark: plan.landmark,
        });
    }
  }

  // entry.kind === 'pre-dispatch': the ordinary gate.
  const preDispatchPlan = planPreDispatchTargetVerification({
    recorded,
    token: entry.token,
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
        scrubVars,
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
        scrubVars,
      ),
    };
  }

  const classification = runtime.classifyTarget({ action, index, token, nodes: observation.nodes });
  if (classification.verified) {
    return dispatchWithGuard(runtime, scrubVars, action, resolvedAction, index, artifactPaths, {
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
      scrubVars,
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
  scrubVars: readonly AdReplayScrubValue[],
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
      scrubVars,
    ),
  };
}
