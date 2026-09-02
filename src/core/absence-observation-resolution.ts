import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { resolveSelectorPipeline } from './selector-pipeline.ts';
import { SELECTOR_PIPELINE_POLICIES } from './selector-pipeline-policy.ts';
import { classifyAbsenceObservation } from './absence-observation.ts';
import { absenceObservationError } from './absence-observation-errors.ts';

export type AbsenceObservationResult = {
  predicate: 'absent';
  pass: true;
  selector: string;
  matches: 0;
};

export async function resolveAbsenceObservation(
  snapshot: SnapshotState,
  selectorExpression: string,
  platform: Platform | PublicPlatform,
): Promise<AbsenceObservationResult> {
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
  const observation = classifyAbsenceObservation(snapshot, matches);
  if (observation.kind !== 'absent') {
    throw absenceObservationError(
      matched.kind === 'target' || matched.kind === 'ambiguous'
        ? matched.selector
        : selectorExpression,
      observation,
    );
  }
  return {
    predicate: 'absent',
    pass: true,
    selector: selectorExpression,
    matches: observation.matches,
  };
}
