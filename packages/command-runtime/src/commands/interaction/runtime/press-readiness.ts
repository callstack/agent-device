import type { ResolvedInteractionTarget } from '@agent-device/contracts/interaction';
import { readSnapshotNativePressTargets } from '@agent-device/contracts/capture';
import { AppError, discloseDispatch } from '@agent-device/kernel/errors';
import { INTERACTION_ERROR_REASONS } from '@agent-device/selectors/interaction-error';

/** The producer's unclipped native identity, not the public canonical projection. */
export function nativePressTarget(resolved: Exclude<ResolvedInteractionTarget, { kind: 'point' }>) {
  const source =
    resolved.preAction &&
    resolved.node &&
    readSnapshotNativePressTargets(resolved.preAction.nodes)?.get(resolved.node.index);
  if (!source || !resolved.point) throw readinessRefusal('missing-source-binding');
  return source;
}

export function readinessRefusal(state: string, cause?: unknown): AppError {
  return discloseDispatch(
    new AppError(
      'COMMAND_FAILED',
      'Resolved target was not ready for input; nothing was dispatched',
      {
        reason: INTERACTION_ERROR_REASONS.targetNotReady,
        readiness: state,
        hint: 'Inspect the current surface and retry when the intended control is available. For an @ref, run snapshot -i and retry with a selector; re-observation can retire the old ref.',
      },
      cause,
    ),
    'no',
  );
}
