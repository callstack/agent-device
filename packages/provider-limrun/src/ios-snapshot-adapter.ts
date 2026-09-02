import type {
  IosAcquisitionResidue,
  IosSnapshotAcquisition,
  IosViewportEvidence,
} from '@agent-device/contracts/ios-snapshot';
import type { SnapshotOptions, SnapshotResult } from '@agent-device/contracts/interactor-types';
import {
  IOS_SNAPSHOT_PRODUCER_CAPABILITIES,
  createIosSnapshotRequest,
  planIosSnapshot,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import {
  IosSnapshotEngineError,
  presentIosSnapshot,
} from '@agent-device/capture-kit/ios-snapshot-engine';
import { AppError } from '@agent-device/kernel/errors';
import { type Rect } from '@agent-device/kernel/snapshot';
import type { LimrunIosSession } from './ios.ts';
import { flattenIosTree, type IosTreeNode } from './snapshot.ts';

const LIMRUN_IOS_PRODUCER = IOS_SNAPSHOT_PRODUCER_CAPABILITIES['limrun-ios-tree'];
type LimrunRect = NonNullable<IosTreeNode['frame']>;
type NumericRect = Readonly<{ x: number; y: number; width: number; height: number }>;

export async function captureLimrunIosSnapshot(
  session: Pick<LimrunIosSession, 'client' | 'instanceId'>,
  options?: SnapshotOptions,
): Promise<SnapshotResult> {
  const request = createIosSnapshotRequest({
    raw: options?.raw,
    interactiveOnly: options?.interactiveOnly,
    depth: options?.depth,
    scope: options?.scope,
    customActions: options?.customActions,
  });
  const plan = planIosSnapshot(request, LIMRUN_IOS_PRODUCER);
  const treeJson = await session.client.elementTree();
  const parsed = JSON.parse(treeJson) as IosTreeNode | IosTreeNode[];
  const nodes = flattenIosTree(parsed);
  const viewport = readLimrunViewport(parsed, session.client.deviceInfo);
  const residue = limrunAcquisitionResidue(plan.evidence.hittability, viewport);
  const hint = { ...plan.hint, acquisitionIntent: 'full' as const };
  const acquisition: IosSnapshotAcquisition = {
    producer: 'limrun-ios-tree',
    intent: 'full',
    hint,
    nodes,
    viewport,
    lineage: { targetId: session.instanceId },
    residue,
  };

  try {
    const presentation = presentIosSnapshot({ stage: 'acquired', acquisition }, request);
    const warnings = limrunSnapshotWarnings(residue);
    return {
      nodes: presentation.nodes,
      backend: 'xctest',
      producer: 'limrun-ios-tree',
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (error) {
    throwLimrunSnapshotError(error, residue);
  }
}

function readLimrunViewport(
  tree: IosTreeNode | IosTreeNode[],
  deviceInfo: { screenWidth?: number; screenHeight?: number } | undefined,
): IosViewportEvidence {
  const treeRect = readLimrunTreeViewport(tree);
  if (treeRect) return { kind: 'derived', rect: treeRect };

  return readLimrunDeviceInfoViewport(deviceInfo);
}

function readLimrunTreeViewport(tree: IosTreeNode | IosTreeNode[]): Rect | undefined {
  const roots = Array.isArray(tree) ? tree : [tree];
  return roots
    .filter(isLimrunViewportRoot)
    .map(readLimrunNodeRect)
    .filter((rect): rect is Rect => rect !== undefined)
    .sort((left, right) => rectArea(right) - rectArea(left))[0];
}

function isLimrunViewportRoot(node: IosTreeNode): boolean {
  const type = (node.elementType ?? node.type ?? node.role ?? '').toLowerCase();
  return type === 'application' || type === 'window';
}

function readLimrunNodeRect(node: IosTreeNode): Rect | undefined {
  const rect = node.rect ?? node.frame;
  if (!isPositiveFiniteRect(rect)) return undefined;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function readLimrunDeviceInfoViewport(
  deviceInfo: { screenWidth?: number; screenHeight?: number } | undefined,
): IosViewportEvidence {
  const width = deviceInfo?.screenWidth;
  const height = deviceInfo?.screenHeight;
  if (width === undefined || height === undefined) {
    return { kind: 'missing', reason: 'not-provided' };
  }
  if (!isPositiveFiniteNumber(width) || !isPositiveFiniteNumber(height)) {
    return { kind: 'missing', reason: 'invalid' };
  }
  return { kind: 'reported', rect: { x: 0, y: 0, width, height } };
}

function isPositiveFiniteRect(rect: LimrunRect | undefined): rect is NumericRect {
  return (
    isFiniteNumber(rect?.x) &&
    isFiniteNumber(rect?.y) &&
    isPositiveFiniteNumber(rect?.width) &&
    isPositiveFiniteNumber(rect?.height)
  );
}

function isPositiveFiniteNumber(value: number | undefined): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function rectArea(rect: Rect): number {
  return rect.width * rect.height;
}

function limrunAcquisitionResidue(
  hittability: 'available' | 'unavailable',
  viewport: IosViewportEvidence,
): IosAcquisitionResidue[] {
  return [
    { kind: 'unavailable-fact', fact: 'truncation' },
    ...(hittability === 'unavailable'
      ? [{ kind: 'unavailable-fact' as const, fact: 'hittability' as const }]
      : []),
    ...(viewport.kind === 'missing'
      ? [{ kind: 'missing-viewport' as const, reason: viewport.reason }]
      : []),
  ];
}

function limrunSnapshotWarnings(residue: readonly IosAcquisitionResidue[]): string[] {
  const warnings: string[] = [];
  if (residue.some((entry) => entry.kind === 'unavailable-fact' && entry.fact === 'truncation')) {
    warnings.push(
      'Limrun iOS tree responses do not expose truncation metadata; tree completeness is not independently verified.',
    );
  }
  if (residue.some((entry) => entry.kind === 'unavailable-fact' && entry.fact === 'hittability')) {
    warnings.push(
      'Limrun iOS snapshots do not provide hittability evidence; regular snapshots will not mark nodes actionable.',
    );
  }
  const viewportWarning = limrunViewportWarning(residue);
  if (viewportWarning) warnings.push(viewportWarning);
  return warnings;
}

function limrunViewportWarning(residue: readonly IosAcquisitionResidue[]): string | undefined {
  const missingViewport = residue.find((entry) => entry.kind === 'missing-viewport');
  return missingViewport
    ? `Limrun iOS snapshots did not provide a valid viewport (${missingViewport.reason}); retry with --raw to inspect the acquired tree, while regular presentation requires viewport evidence.`
    : undefined;
}

function throwLimrunSnapshotError(
  error: unknown,
  residue: readonly IosAcquisitionResidue[],
): never {
  if (!(error instanceof IosSnapshotEngineError)) throw error;
  const hint =
    error.reason === 'missing-viewport' || error.reason === 'invalid-viewport'
      ? limrunViewportWarning(residue)
      : undefined;
  throw new AppError(
    'COMMAND_FAILED',
    error.message,
    {
      reason: error.reason,
      iosSnapshotEngine: { details: error.details },
      ...(hint ? { hint } : {}),
    },
    error,
  );
}
