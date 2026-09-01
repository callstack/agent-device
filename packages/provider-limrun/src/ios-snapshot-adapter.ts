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
import type { LimrunIosSession } from './ios.ts';
import { flattenIosTree, type IosTreeNode } from './snapshot.ts';

const LIMRUN_IOS_PRODUCER = IOS_SNAPSHOT_PRODUCER_CAPABILITIES['limrun-ios-tree'];

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
  const nodes = flattenIosTree(JSON.parse(treeJson) as IosTreeNode | IosTreeNode[]);
  const viewport = readLimrunViewport(session.client.deviceInfo);
  const residue = limrunAcquisitionResidue(plan.evidence.hittability, viewport);
  const hint = { ...plan.hint, acquisitionIntent: 'full' as const };
  const acquisition: IosSnapshotAcquisition = {
    producer: 'limrun-ios-tree',
    intent: 'full',
    hint,
    nodes,
    truncated: false,
    viewport,
    lineage: { targetId: session.instanceId },
    residue,
  };

  try {
    const presentation = presentIosSnapshot({ stage: 'acquired', acquisition }, request);
    const warnings = limrunSnapshotWarnings(residue);
    return {
      nodes: presentation.nodes,
      truncated: acquisition.truncated,
      backend: 'xctest',
      producer: 'limrun-ios-tree',
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (error) {
    throwLimrunSnapshotError(error);
  }
}

function readLimrunViewport(
  deviceInfo: { screenWidth?: number; screenHeight?: number } | undefined,
): IosViewportEvidence {
  const width = deviceInfo?.screenWidth;
  const height = deviceInfo?.screenHeight;
  if (typeof width !== 'number' || typeof height !== 'number') {
    return { kind: 'missing', reason: 'not-provided' };
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { kind: 'missing', reason: 'invalid' };
  }
  return { kind: 'reported', rect: { x: 0, y: 0, width, height } };
}

function limrunAcquisitionResidue(
  hittability: 'available' | 'unavailable',
  viewport: IosViewportEvidence,
): IosAcquisitionResidue[] {
  return [
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
  if (residue.some((entry) => entry.kind === 'unavailable-fact' && entry.fact === 'hittability')) {
    warnings.push(
      'Limrun iOS snapshots do not provide hittability evidence; regular snapshots will not mark nodes actionable.',
    );
  }
  const missingViewport = residue.find((entry) => entry.kind === 'missing-viewport');
  if (missingViewport) {
    warnings.push(
      `Limrun iOS snapshots did not provide a valid viewport (${missingViewport.reason}); raw output is available, but regular presentation requires viewport evidence.`,
    );
  }
  return warnings;
}

function throwLimrunSnapshotError(error: unknown): never {
  if (!(error instanceof IosSnapshotEngineError)) throw error;
  throw new AppError(
    'COMMAND_FAILED',
    error.message,
    { reason: error.reason, iosSnapshotEngine: { details: error.details } },
    error,
  );
}
