import { AppError } from '@agent-device/kernel/errors';
import type { SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import {
  localIdentitiesEqual,
  readNodeLocalIdentity,
  readNodeStructuralDenotation,
  structuralDenotationsEqual,
} from '@agent-device/ad-script';
import { REPLAY_TARGET_GUARD_MISMATCH_REASON } from '@agent-device/contracts/replay';
import type {
  ExpectedResolvedTarget,
  ResolveInteractionTargetParams,
} from './interaction-resolution-request.ts';

/**
 * Compares the resolution winner (pre-promotion: hittable-ancestor promotion
 * deliberately retargets to the same LEAF's actionable container and must not
 * trip the guard — duplicates are distinct leaves with distinct structural
 * denotations, so comparing the leaf is exactly right) against the verified
 * member's local identity AND structural denotation; throws pre-action when
 * EITHER differs.
 */
export function assertExpectedResolvedTarget(
  node: SnapshotNode,
  nodes: SnapshotState['nodes'],
  expected: ExpectedResolvedTarget | undefined,
  action: string,
  targetRole?: 'source' | 'destination',
): void {
  if (!expected) return;
  const observedIdentity = readNodeLocalIdentity(node);
  const observedStructural = readNodeStructuralDenotation(node, nodes);
  if (
    localIdentitiesEqual(observedIdentity, expected.identity) &&
    structuralDenotationsEqual(observedStructural, expected.structural)
  ) {
    return;
  }
  throw new AppError(
    'COMMAND_FAILED',
    `${action} resolved to a different element than replay verification isolated; the action was not sent`,
    {
      reason: REPLAY_TARGET_GUARD_MISMATCH_REASON,
      observed: observedIdentity,
      observedStructural,
      expected: expected.identity,
      expectedStructural: expected.structural,
      ...(targetRole ? { targetRole } : {}),
    },
  );
}

export function assertReplayTargetResolution(
  node: SnapshotNode,
  nodes: SnapshotState['nodes'],
  params: ResolveInteractionTargetParams,
): void {
  assertExpectedResolvedTarget(
    node,
    nodes,
    params.expectedResolvedTarget,
    params.action,
    params.replayTargetRole,
  );
}
