import { AppError } from '@agent-device/kernel/errors';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { inheritPostGestureOutcome } from '@agent-device/kernel/snapshot';
import {
  formatSelectorFailure,
  selectorFailureHint,
  type SelectorResolution,
} from '@agent-device/selectors';
import { resolveSelectorPipeline } from '@agent-device/selectors/selector-pipeline';
import {
  SELECTOR_PIPELINE_POLICIES,
  type ReadinessSchedule,
} from '@agent-device/selectors/selector-pipeline-policy';
import { INTERACTION_ERROR_REASONS } from '@agent-device/selectors/interaction-error';
import { observeUntil } from '@agent-device/capture-kit/observe-until';
import { isSparseSnapshotQualityVerdict } from '@agent-device/capture-kit/snapshot-quality-verdict';
import { isUnreadableCaptureContentError } from '@agent-device/contracts/android-snapshot-quality';
import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import {
  captureInteractionSnapshot,
  type InteractionSnapshot,
} from './interaction-snapshot-capture.ts';
import { buildCoveredInteractionError } from './target-visibility-stages.ts';
import { resolveActionSelector } from './selector-action-resolution.ts';
import type {
  InteractionAction,
  ResolveInteractionTargetParams,
} from './interaction-resolution-request.ts';

/**
 * `promotedTarget`'s readiness poll: the one-attempt capture-and-resolve, the covered-target
 * diagnosis it shares with the exhausted-budget failure, and the `observeUntil`-driven loop itself.
 * `resolution.ts#resolveSelectorInteractionTarget` is this module's one caller, deciding whether a
 * call polls at all and under what capped budget.
 */

/** One poll's outcome: the capture it read the tree from, and what it resolved (if anything). */
export type SelectorResolutionAttempt = {
  capture: InteractionSnapshot;
  resolved: SelectorResolution | null;
};

/** The narrowed attempt a readiness poll accepts: a resolution with a usable rect. */
export type ResolvedSelectorAttempt = {
  capture: InteractionSnapshot;
  resolved: SelectorResolution;
  /** The wait that preceded the hit; absent when the first capture resolved. */
  readiness?: SelectorReadinessWait;
};

/** What a successful readiness wait reports: present only when more than one capture was needed. */
export type SelectorReadinessWait = Pick<SelectorReadinessDetails, 'polls' | 'waitedMs'>;

/** The readiness poll's evidence, attached to a target-not-found failure only (never to a refusal). */
export type SelectorReadinessDetails = {
  polls: number;
  waitedMs: number;
  end: 'expired' | 'stalled' | 'sparse';
};

/**
 * One capture-and-resolve attempt: interactive capture, resolve; on a miss that requires
 * interactivity, fall back to a full (non-interactive) capture and resolve again. Identical body
 * whether run once (`promotedTarget.poll`'s one-attempt twin, `resolvedTarget`) or repeated under
 * `observeUntil` for a call that polls — this function draws no distinction, and does not decide
 * whether the miss is a refusal (ambiguity, occlusion, off-screen) or a plain no-match: those stay
 * the caller's decisions, made from `resolved`/thrown errors exactly as before.
 */
export async function attemptSelectorResolution(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  selectorExpression: string,
  params: ResolveInteractionTargetParams,
): Promise<SelectorResolutionAttempt> {
  let capture = await captureInteractionSnapshot(runtime, options, params.requireInteractive);
  let resolved = resolveActionSelector(
    capture.snapshot.nodes,
    selectorExpression,
    runtime.backend.platform,
    params.pipeline,
  );
  if ((!resolved || !resolved.node.rect) && params.requireInteractive) {
    const interactive = capture.snapshot;
    capture = await captureInteractionSnapshot(runtime, options, false);
    inheritPostGestureOutcome(interactive, capture.snapshot);
    resolved = resolveActionSelector(
      capture.snapshot.nodes,
      selectorExpression,
      runtime.backend.platform,
      params.pipeline,
    );
  }
  return { capture, resolved };
}

/**
 * No usable acting target. Before reporting "did not match", re-probe the same
 * tree through the diagnosis row: a selector that DOES match but landed on a
 * covered node is a different failure with a different recovery, and the
 * acting row — rect-required, candidates rejected — cannot tell the caller
 * that. Both probes name a policy row, so the two contracts stay visible side
 * by side instead of as two sets of engine knobs.
 *
 * The diagnosis row keeps covered nodes as candidates precisely so its occlusion stage can report
 * them: "matched but covered" is a different failure than "did not match", produced by re-probing
 * the same tree under `coveredDiagnosis` rather than by the acting row's own (candidate-excluding)
 * resolution. Shared by the single-attempt failure path and the readiness poll: a covered target is
 * a refusal, not an absence, and must end a poll loop rather than spend its budget (a `promotedTarget`
 * poll cannot otherwise tell "excluded because covered" apart from "does not exist yet").
 */
async function detectCoveredSelectorTarget(params: {
  runtime: AgentDeviceRuntime;
  nodes: SnapshotState['nodes'];
  selectorExpression: string;
  action: InteractionAction;
}): Promise<AppError | undefined> {
  const { runtime, nodes, selectorExpression, action } = params;
  const covered = await resolveSelectorPipeline(
    SELECTOR_PIPELINE_POLICIES.coveredDiagnosis,
    nodes,
    selectorExpression,
    { platform: runtime.backend.platform },
  );
  if (covered.kind !== 'occluded') return undefined;
  return buildCoveredInteractionError({
    label: `Selector ${covered.selector}`,
    node: covered.node,
    action,
    selector: covered.selector,
  });
}

/**
 * Shared by the one-attempt path (`resolution.ts#resolveSelectorInteractionTarget`) and this
 * module's own exhausted-budget path: the same "selector not found" shape either way, covered
 * targets disclosed through `detectCoveredSelectorTarget` first.
 */
export async function selectorInteractionFailure(params: {
  runtime: AgentDeviceRuntime;
  nodes: SnapshotState['nodes'];
  selectorExpression: string;
  action: InteractionAction;
  resolved: SelectorResolution | null;
}): Promise<AppError> {
  const { runtime, nodes, selectorExpression, action, resolved } = params;
  const covered = await detectCoveredSelectorTarget({ runtime, nodes, selectorExpression, action });
  if (covered) return covered;
  const diagnostics = resolved?.diagnostics ?? [];
  return new AppError(
    'COMMAND_FAILED',
    formatSelectorFailure(selectorExpression, diagnostics, { unique: true }),
    {
      reason: INTERACTION_ERROR_REASONS.selectorNotFound,
      hint: selectorFailureHint(diagnostics),
    },
  );
}

/**
 * One readiness poll: a capture-and-resolve attempt, the previous poll's post-gesture outcome
 * carried forward, and the covered-target probe on a miss. A covered candidate is excluded by
 * promotedTarget's own occlusion stage before it reaches `resolved`, so it looks identical to
 * "not found yet"; detecting it here ends the loop on this poll instead of spending the budget on a
 * target that will never stop being covered.
 */
async function pollSelectorReadinessOnce(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  selectorExpression: string,
  params: ResolveInteractionTargetParams,
  previousPoll: InteractionSnapshot | undefined,
): Promise<SelectorResolutionAttempt> {
  const attempt = await attemptSelectorResolution(runtime, options, selectorExpression, params);
  if (previousPoll) inheritPostGestureOutcome(previousPoll.snapshot, attempt.capture.snapshot);
  if (attempt.resolved?.node.rect) return attempt;
  const quality = attempt.capture.snapshot.snapshotQuality;
  if (isSparseSnapshotQualityVerdict(quality)) {
    throw new AppError(
      'COMMAND_FAILED',
      `Selector ${selectorExpression} was not found in a sparse capture; the tree cannot prove it absent`,
      {
        reason: INTERACTION_ERROR_REASONS.captureSparse,
        snapshotQuality: quality,
        hint: 'Re-run after the screen settles, or capture a snapshot to inspect the tree.',
      },
    );
  }
  const covered = await detectCoveredSelectorTarget({
    runtime,
    nodes: attempt.capture.snapshot.nodes,
    selectorExpression,
    action: params.action,
  });
  if (covered) throw covered;
  return attempt;
}

/**
 * The budget is spent or a capture stalled at the deadline. When no poll ever observed the tree, the
 * last ridden-out capture error is the cause and is raised as such; otherwise the ordinary
 * selector failure carries the readiness evidence.
 */
async function readinessExhaustedFailure(
  runtime: AgentDeviceRuntime,
  selectorExpression: string,
  params: ResolveInteractionTargetParams,
  observed: Extract<
    Awaited<ReturnType<typeof observeUntil<SelectorResolutionAttempt, ResolvedSelectorAttempt>>>,
    { kind: 'expired' | 'stalled' }
  >,
): Promise<AppError | unknown> {
  if (observed.last === undefined && observed.lastError !== undefined) return observed.lastError;
  const readiness: SelectorReadinessDetails = {
    polls: observed.polls.length,
    waitedMs: observed.waitedMs,
    end: observed.kind,
  };
  const failure = await selectorInteractionFailure({
    runtime,
    nodes: observed.last?.capture.snapshot.nodes ?? [],
    selectorExpression,
    action: params.action,
    resolved: observed.last?.resolved ?? null,
  });
  failure.details = { ...failure.details, readiness };
  return failure;
}

/**
 * `promotedTarget`'s readiness budget: the target may not exist yet, so a plain no-match (no
 * resolution, or a resolution with no usable rect) keeps polling under `schedule` instead of
 * refusing on the first capture. Every other outcome stays terminal exactly as a single attempt
 * would produce it — an ambiguity throw from `resolveActionSelector`, or a capture error the loop
 * does not ride out, ends the loop on this same poll, and is rethrown unchanged. Occlusion,
 * off-screen, non-hittable, and keyboard refusals are not judged here: they run once, after this
 * loop returns a rect-bearing resolution, as `runInteractionPipelineStages` does.
 *
 * The first poll is unbounded, so a caller whose first capture already matches pays the
 * one-or-two-capture cost of a single attempt.
 *
 * ADR 0011 registry anchor: interaction-guarantees.ts cites this as the runtime-selector
 * `targetReadiness` `via` symbol.
 */
export async function pollForSelectorReadiness(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  selectorExpression: string,
  params: ResolveInteractionTargetParams,
  schedule: ReadinessSchedule,
): Promise<ResolvedSelectorAttempt> {
  const signal = options.signal ?? runtime.signal;
  let previousPoll: InteractionSnapshot | undefined;
  const observed = await observeUntil<SelectorResolutionAttempt, ResolvedSelectorAttempt>({
    capture: async (pollSignal) => {
      const attempt = await pollSelectorReadinessOnce(
        runtime,
        { ...options, signal: pollSignal },
        selectorExpression,
        params,
        previousPoll,
      );
      previousPoll = attempt.capture;
      return attempt;
    },
    verdict: (latest) =>
      latest.resolved && latest.resolved.node.rect
        ? { kind: 'done', result: { capture: latest.capture, resolved: latest.resolved } }
        : { kind: 'continue' },
    schedule: {
      ...schedule,
      // The poll signal reaches the platform as CaptureSnapshotInput.signal, which the snapshot
      // binding joins (captureSnapshotSignal): the same per-capture cancellation `wait` relies on.
      captureDeadline: 'cancel',
    },
    rideOut: isUnreadableCaptureContentError,
    ...(signal ? { signal } : {}),
    ...(runtime.clock ? { clock: runtime.clock } : {}),
    phase: 'interaction_target_readiness',
  });
  if (observed.kind === 'done') {
    return observed.polls.length > 1
      ? {
          ...observed.result,
          readiness: { polls: observed.polls.length, waitedMs: observed.waitedMs },
        }
      : observed.result;
  }
  if (observed.kind === 'failed') throw withSparseReadiness(observed.error, observed);
  throw await readinessExhaustedFailure(runtime, selectorExpression, params, observed);
}

function withSparseReadiness(
  error: unknown,
  observed: { polls: readonly unknown[]; waitedMs: number },
): unknown {
  if (
    !(error instanceof AppError) ||
    error.details?.reason !== INTERACTION_ERROR_REASONS.captureSparse
  ) {
    return error;
  }
  const readiness: SelectorReadinessDetails = {
    polls: observed.polls.length,
    waitedMs: observed.waitedMs,
    end: 'sparse',
  };
  error.details = { ...error.details, readiness };
  return error;
}
