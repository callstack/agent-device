import { extractNodeText, normalizeType } from '@agent-device/contracts/snapshot';
import {
  readNodeLocalIdentity,
  TARGET_ANNOTATION_MAX_FIELD_BYTES,
  truncateToUtf8Bytes,
} from '@agent-device/ad-script';
import type { SnapshotNode, SnapshotQualityVerdict } from '@agent-device/kernel/snapshot';
import type { PostGestureOutcome, SnapshotState } from '@agent-device/contracts/snapshot-model';

export type AbsenceFirstMatch = {
  id?: string;
  role: string;
  label?: string;
  text?: string;
};

type SparseQuality = Pick<SnapshotQualityVerdict, 'backend' | 'reason' | 'reasonCode'> & {
  state: 'sparse';
};

const LEGACY_IOS_SPARSE_QUALITY: SparseQuality = {
  state: 'sparse',
  backend: 'tree',
  reason: 'legacy iOS capture exposed only the application root',
  reasonCode: 'sparse-tree',
};

export type AbsenceObservation =
  | { kind: 'absent'; matches: 0 }
  | { kind: 'present'; matches: number; firstMatch: AbsenceFirstMatch }
  | { kind: 'sparse'; matches: number; firstMatch?: AbsenceFirstMatch; quality: SparseQuality }
  | { kind: 'truncated'; matches: number; firstMatch?: AbsenceFirstMatch }
  | { kind: 'unsettled'; matches: 0 }
  | { kind: 'loading'; matches: 0 };

/** Why a capture with no match still cannot prove absence. */
export const UNPROVABLE_ABSENCE_CAUSES = {
  sparse: 'capture was sparse',
  truncated: 'capture was truncated',
  unsettled: 'the surface was still changing after a gesture',
  loading: 'the launched app was still loading its first screen',
} as const;

export type UnprovableAbsenceKind = keyof typeof UNPROVABLE_ABSENCE_CAUSES;

/** Which post-gesture outcomes leave a zero-match capture unable to prove absence; every kind must be listed. */
const ABSENCE_UNPROVEN_BY_OUTCOME: Readonly<
  Record<PostGestureOutcome['kind'], 'unsettled' | 'loading' | undefined>
> = {
  unsettled: 'unsettled',
  loading: 'loading',
  'no-effect': undefined,
};

export function isUnprovableAbsence(kind: unknown): kind is UnprovableAbsenceKind {
  return typeof kind === 'string' && Object.hasOwn(UNPROVABLE_ABSENCE_CAUSES, kind);
}

export type AbsenceCaptureOption = 'depth' | 'scope';

export function absenceCaptureOptionRefusal(options: {
  depth?: number;
  scope?: string;
}): AbsenceCaptureOption | undefined {
  if (options.scope !== undefined) return 'scope';
  if (options.depth !== undefined) return 'depth';
  return undefined;
}

export function absenceCaptureOptionMessage(
  option: AbsenceCaptureOption,
  command: 'is' | 'wait' = 'is',
): string {
  const surface = `${command} absent`;
  return option === 'scope'
    ? `${surface} does not support --scope; it requires an unscoped capture`
    : `${surface} does not support --depth; it requires a full-depth capture`;
}

export function classifyAbsenceObservation(
  snapshot: Pick<
    SnapshotState,
    'backend' | 'nodes' | 'snapshotQuality' | 'truncated' | 'postGestureOutcome'
  >,
  matches: readonly SnapshotNode[],
): AbsenceObservation {
  const firstMatch = matches[0] ? stableFirstMatch(matches[0]) : undefined;
  const matchCount = matches.length;
  if (snapshot.truncated === true) {
    return {
      kind: 'truncated',
      matches: matchCount,
      ...(firstMatch ? { firstMatch } : {}),
    };
  }
  const sparseQuality = sparseCaptureQuality(snapshot);
  if (sparseQuality) {
    return {
      kind: 'sparse',
      matches: matchCount,
      ...(firstMatch ? { firstMatch } : {}),
      quality: {
        state: sparseQuality.state,
        backend: sparseQuality.backend,
        ...(sparseQuality.reason ? { reason: sparseQuality.reason } : {}),
        ...(sparseQuality.reasonCode ? { reasonCode: sparseQuality.reasonCode } : {}),
      },
    };
  }
  if (matchCount === 0) return zeroMatchObservation(snapshot.postGestureOutcome);
  return { kind: 'present', matches: matchCount, firstMatch: firstMatch! };
}

/** A zero-match capture proves absence unless its post-gesture outcome left the screen unproven. */
function zeroMatchObservation(outcome: PostGestureOutcome | undefined): AbsenceObservation {
  const unproven = outcome ? ABSENCE_UNPROVEN_BY_OUTCOME[outcome.kind] : undefined;
  return unproven ? { kind: unproven, matches: 0 } : { kind: 'absent', matches: 0 };
}

/**
 * The one definition of "this capture is too sparse to trust": the backend's own verdict, then the
 * legacy iOS shape that predates verdicts. Shared with `scroll --until`, which must not stop on a
 * tree whose selectors are unreliable.
 */
export function sparseCaptureQuality(
  snapshot: Pick<SnapshotState, 'backend' | 'nodes' | 'snapshotQuality'>,
): SparseQuality | undefined {
  const quality = snapshot.snapshotQuality;
  if (quality?.state === 'sparse') {
    return {
      state: quality.state,
      backend: quality.backend,
      ...(quality.reason ? { reason: quality.reason } : {}),
      ...(quality.reasonCode ? { reasonCode: quality.reasonCode } : {}),
    };
  }
  return isLegacySparseIosInteractiveSnapshot(snapshot) ? LEGACY_IOS_SPARSE_QUALITY : undefined;
}

export function isLegacySparseIosInteractiveSnapshot(
  snapshot: Pick<SnapshotState, 'backend' | 'nodes' | 'snapshotQuality'>,
): boolean {
  if (snapshot.snapshotQuality) return false;
  if (snapshot.backend !== 'xctest' || snapshot.nodes.length !== 1) return false;
  return normalizeType(snapshot.nodes[0]?.type ?? '') === 'application';
}

function stableFirstMatch(node: SnapshotNode): AbsenceFirstMatch {
  const identity = readNodeLocalIdentity(node);
  const text = truncateToUtf8Bytes(extractNodeText(node), TARGET_ANNOTATION_MAX_FIELD_BYTES);
  return {
    ...identity,
    ...(text && text !== identity.label ? { text } : {}),
  };
}
