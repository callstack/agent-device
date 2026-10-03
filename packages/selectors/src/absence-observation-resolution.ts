import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { resolveSelectorPipeline } from './selector-pipeline.ts';
import { SELECTOR_PIPELINE_POLICIES } from './selector-pipeline-policy.ts';
import { classifyAbsenceObservation, type AbsenceObservation } from './absence-observation.ts';
import { absenceObservationError } from './absence-observation-errors.ts';

export type AbsenceObservationResult = {
  predicate: 'absent';
  pass: true;
  selector: string;
  matches: 0;
};

export type ResolvedAbsenceObservation = {
  selector: string;
  observation: AbsenceObservation;
};

export async function resolveAbsenceObservationState(
  snapshot: SnapshotState,
  selectorExpression: string,
  platform: Platform | PublicPlatform,
): Promise<ResolvedAbsenceObservation> {
  const matched = await resolveSelectorPipeline(
    SELECTOR_PIPELINE_POLICIES.readAny,
    snapshot.nodes,
    selectorExpression,
    { platform },
  );
  const matches =
    matched.kind === 'target' || matched.kind === 'ambiguous'
      ? matched.matchedNodes
      : matched.kind === 'occluded'
        ? [matched.node]
        : [];
  return {
    selector:
      matched.kind === 'target' || matched.kind === 'ambiguous'
        ? matched.selector
        : selectorExpression,
    observation: classifyAbsenceObservation(snapshot, matches),
  };
}

export async function resolveAbsenceObservation(
  snapshot: SnapshotState,
  selectorExpression: string,
  platform: Platform | PublicPlatform,
): Promise<AbsenceObservationResult> {
  const resolved = await resolveAbsenceObservationState(snapshot, selectorExpression, platform);
  const observation = resolved.observation;
  if (observation.kind !== 'absent') {
    throw absenceObservationError(resolved.selector, observation);
  }
  return {
    predicate: 'absent',
    pass: true,
    selector: selectorExpression,
    matches: observation.matches,
  };
}
