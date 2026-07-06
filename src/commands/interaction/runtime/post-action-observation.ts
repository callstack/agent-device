import type { SnapshotNode } from '../../../kernel/snapshot.ts';
import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import { summarizeAxEvidence } from '../../../utils/ax-digest.ts';
import type {
  InteractionEvidence,
  ResolvedInteractionTarget,
  SettleObservation,
  SettleParams,
} from '../../../contracts/interaction.ts';
import { captureInteractionSnapshot } from './resolution.ts';
import { settleAfterInteraction, settleEvidence } from './settle.ts';

type ObservedResult<T extends object> = T & {
  evidence?: InteractionEvidence;
  settle?: SettleObservation;
};

export async function applyPostActionObservation<T extends object>(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  resolved: ResolvedInteractionTarget,
  result: T,
  params: { verify?: boolean; settle?: SettleParams | undefined },
): Promise<ObservedResult<T>> {
  const observed = await observeAfterInteraction(runtime, options, resolved, {
    verify: params.verify === true,
    settle: params.settle,
  });
  return reconcileNonHittableHintWithEvidence({ ...result, ...observed });
}

/**
 * Post-action observation composition: `--settle` runs the quiet-window loop
 * (settle.ts) and, when `--verify` rides along, its final capture doubles as
 * the evidence source. Without settle, verify keeps its single dedicated
 * capture. Best-effort: observation never turns a successful action into a
 * failure.
 */
async function observeAfterInteraction(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  resolved: ResolvedInteractionTarget,
  params: { verify: boolean; settle: SettleParams | undefined },
): Promise<{ evidence?: InteractionEvidence; settle?: SettleObservation }> {
  if (params.settle) {
    const outcome = await settleAfterInteraction(runtime, options, {
      ...params.settle,
      resolved,
    });
    const evidence = params.verify
      ? settleEvidence(
          outcome.settledNodes,
          'preActionNodes' in resolved ? resolved.preActionNodes : undefined,
        )
      : undefined;
    return { settle: outcome.observation, ...(evidence ? { evidence } : {}) };
  }
  if (!params.verify) return {};
  const evidence = await captureVerifyEvidence(runtime, options, resolved);
  return evidence ? { evidence } : {};
}

/**
 * Post-action side of `--verify` (#1047): one interactive-only capture through
 * the same capture helper the resolution path already uses, digested and then
 * discarded. The node tree itself is never attached to the result, only the
 * cheap summary.
 */
async function captureVerifyEvidence(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  resolved: ResolvedInteractionTarget,
): Promise<InteractionEvidence | undefined> {
  const preActionNodes: SnapshotNode[] | undefined =
    'preActionNodes' in resolved ? resolved.preActionNodes : undefined;
  try {
    const capture = await captureInteractionSnapshot(runtime, options, true);
    const after = summarizeAxEvidence(capture.snapshot.nodes);
    // No pre-action baseline means we cannot claim a change happened; default
    // to false rather than asserting a change we did not actually observe.
    const changedFromBefore =
      preActionNodes !== undefined && after.digest !== summarizeAxEvidence(preActionNodes).digest;
    return { ...after, changedFromBefore };
  } catch {
    return undefined;
  }
}

// The resolution-time non-hittable hint warns the action "may have had no
// visible effect". When --verify evidence proves the interactive tree changed,
// or --settle returns a material diff, that warning is contradicted by data
// sitting next to it in the same response; drop it and let targetHittable plus
// the observation speak for themselves.
function reconcileNonHittableHintWithEvidence<T extends object>(result: ObservedResult<T>): T {
  // Widened view: point-target results carry none of these fields, which is
  // exactly the no-op path.
  const view = result as {
    targetHittable?: boolean;
    hint?: string;
    evidence?: InteractionEvidence;
    settle?: SettleObservation;
  };
  if (
    view.targetHittable !== false ||
    !hasMaterialPostActionChange(view) ||
    view.hint === undefined
  ) {
    return result;
  }
  const { hint: _hint, ...rest } = view;
  return rest as T;
}

function hasMaterialPostActionChange(view: {
  evidence?: InteractionEvidence;
  settle?: SettleObservation;
}): boolean {
  if (view.evidence?.changedFromBefore === true) return true;
  const summary = view.settle?.diff?.summary;
  return !!summary && (summary.additions > 0 || summary.removals > 0);
}
