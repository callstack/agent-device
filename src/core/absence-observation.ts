import { extractNodeText, normalizeType } from '@agent-device/contracts/snapshot';
import {
  readNodeLocalIdentity,
  TARGET_ANNOTATION_MAX_FIELD_BYTES,
  truncateToUtf8Bytes,
} from '@agent-device/ad-script';
import type {
  SnapshotNode,
  SnapshotQualityVerdict,
  SnapshotState,
} from '@agent-device/kernel/snapshot';

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
  | { kind: 'truncated'; matches: number; firstMatch?: AbsenceFirstMatch };

export type AbsenceCaptureOption = 'depth' | 'scope';

export function absenceCaptureOptionRefusal(options: {
  depth?: number;
  scope?: string;
}): AbsenceCaptureOption | undefined {
  if (options.scope !== undefined) return 'scope';
  if (options.depth !== undefined) return 'depth';
  return undefined;
}

export function absenceCaptureOptionMessage(option: AbsenceCaptureOption): string {
  return option === 'scope'
    ? 'is absent does not support --scope; it requires an unscoped capture'
    : 'is absent does not support --depth; it requires a full-depth capture';
}

export function classifyAbsenceObservation(
  snapshot: Pick<SnapshotState, 'backend' | 'nodes' | 'snapshotQuality' | 'truncated'>,
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
  const sparseQuality = sparseQualityForSnapshot(snapshot);
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
  if (matchCount === 0) return { kind: 'absent', matches: 0 };
  return { kind: 'present', matches: matchCount, firstMatch: firstMatch! };
}

function sparseQualityForSnapshot(
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
