import type { InteractionEvidence, SettleObservation } from '../../../contracts/interaction.ts';

// The resolution-time non-hittable hint warns the action "may have had no
// visible effect". When --verify evidence proves the interactive tree changed,
// or --settle returns a material diff, that warning is contradicted by data
// sitting next to it in the same response; drop it and let targetHittable plus
// the observation speak for themselves.
export function reconcileNonHittableHintWithEvidence<T extends object>(result: T): T {
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
