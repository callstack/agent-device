import type {
  RawSnapshotNode,
  Rect,
  SnapshotNativePressTarget,
} from '@agent-device/kernel/snapshot';
import type { IosViewportEvidence } from './ios-snapshot.ts';

/**
 * Capture-local clickability facts for consumers that reproduce Maestro's private
 * TreeNode semantics. This is deliberately kept outside SnapshotNode: the fact
 * is retained by object identity, never serialized into the snapshot contract.
 */
export type SnapshotClickabilityEvidence =
  | {
      kind: 'exact';
      provider: 'android-helper';
      clickableByNodeIndex: ReadonlyMap<number, boolean | undefined>;
    }
  | {
      kind: 'divergence';
      provider: 'apple-xctest';
      reason: 'maestro-clickable-not-exposed-by-provider';
    };

export type AndroidSiblingOrderEvidence = { group: number; order: number };

export type SnapshotOcclusionContextEvidence = {
  /** Broad normalized presentation input retained when the public result is scoped. */
  nodes: readonly RawSnapshotNode[];
  /** Public input node index to its corresponding index in `nodes`. */
  sourceIndexByNodeIndex: ReadonlyMap<number, number>;
  /** Exact Android order plus an opaque original-sibling group (API 24+). */
  androidSiblingOrderByNodeIndex?: ReadonlyMap<number, AndroidSiblingOrderEvidence>;
};

/** Complete text-input geometry measured before iOS semantic projection; absent means unknown. */
export type SnapshotTextInputGeometry = Readonly<{ rects: readonly Rect[] }>;

export type SnapshotNativePressTargets = ReadonlyMap<number, SnapshotNativePressTarget>;

type SnapshotPrivateEvidence = {
  viewport?: IosViewportEvidence;
  nativePressTargets?: SnapshotNativePressTargets;
  textInputGeometry?: SnapshotTextInputGeometry;
  clickability?: SnapshotClickabilityEvidence;
  occlusionContext?: SnapshotOcclusionContextEvidence;
};

const privateEvidenceBySnapshotObject = new WeakMap<object, SnapshotPrivateEvidence>();

/** Refuses coordinate-derived input when the capture could not establish its screen origin. */
export async function assertSnapshotScreenOrigin(owner: object, label: string): Promise<void> {
  const viewport = readSnapshotViewportEvidence(owner);
  if (viewport && viewport.kind !== 'reported') {
    const { AppError, discloseDispatch } = await import('@agent-device/kernel/errors');
    throw discloseDispatch(
      new AppError('COMMAND_FAILED', `${label} has no established screen-coordinate origin`, {
        reason: 'window-origin-unknown',
        hint: 'Take a fresh snapshot after the accessibility channel recovers, or use screenshot to choose screen coordinates.',
      }),
      'no',
    );
  }
}

/** The producer's viewport authority for this exact capture, retained outside public node data. */
export function attachSnapshotViewportEvidence<T extends object>(
  owner: T,
  viewport: IosViewportEvidence,
): T {
  return attachSnapshotPrivateEvidence(owner, { viewport });
}

function readSnapshotViewportEvidence(
  owner: object | null | undefined,
): IosViewportEvidence | undefined {
  return owner ? privateEvidenceBySnapshotObject.get(owner)?.viewport : undefined;
}

export function copySnapshotViewportEvidence<T extends object>(
  source: object | null | undefined,
  target: T,
): T {
  const viewport = readSnapshotViewportEvidence(source);
  return viewport ? attachSnapshotViewportEvidence(target, viewport) : target;
}

function attachSnapshotPrivateEvidence<T extends object>(
  owner: T,
  evidence: SnapshotPrivateEvidence,
): T {
  privateEvidenceBySnapshotObject.set(owner, {
    ...privateEvidenceBySnapshotObject.get(owner),
    ...evidence,
  });
  return owner;
}

export function attachSnapshotClickabilityEvidence<T extends object>(
  owner: T,
  evidence: SnapshotClickabilityEvidence,
): T {
  return attachSnapshotPrivateEvidence(owner, { clickability: evidence });
}

export function readSnapshotClickabilityEvidence(
  owner: object | null | undefined,
): SnapshotClickabilityEvidence | undefined {
  return owner ? privateEvidenceBySnapshotObject.get(owner)?.clickability : undefined;
}

export function copySnapshotClickabilityEvidence<T extends object>(
  source: object | null | undefined,
  target: T,
): T {
  const evidence = readSnapshotClickabilityEvidence(source);
  return evidence ? attachSnapshotClickabilityEvidence(target, evidence) : target;
}

export function attachSnapshotOcclusionContextEvidence<T extends object>(
  owner: T,
  evidence: SnapshotOcclusionContextEvidence,
): T {
  return attachSnapshotPrivateEvidence(owner, { occlusionContext: evidence });
}

export function readSnapshotOcclusionContextEvidence(
  owner: object | null | undefined,
): SnapshotOcclusionContextEvidence | undefined {
  return owner ? privateEvidenceBySnapshotObject.get(owner)?.occlusionContext : undefined;
}

export function attachSnapshotTextInputGeometry<T extends object>(
  owner: T,
  geometry: SnapshotTextInputGeometry,
): T {
  return attachSnapshotPrivateEvidence(owner, { textInputGeometry: geometry });
}

export function readSnapshotTextInputGeometry(
  owner: object | null | undefined,
): SnapshotTextInputGeometry | undefined {
  return owner ? privateEvidenceBySnapshotObject.get(owner)?.textInputGeometry : undefined;
}

export function attachSnapshotNativePressTargets<T extends object>(
  owner: T,
  targets: SnapshotNativePressTargets,
): T {
  return attachSnapshotPrivateEvidence(owner, { nativePressTargets: targets });
}

export function readSnapshotNativePressTargets(
  owner: object,
): SnapshotNativePressTargets | undefined {
  return privateEvidenceBySnapshotObject.get(owner)?.nativePressTargets;
}

export function copySnapshotNativePressTargets<T extends object>(source: object, target: T): T {
  const targets = readSnapshotNativePressTargets(source);
  return targets ? attachSnapshotNativePressTargets(target, targets) : target;
}
