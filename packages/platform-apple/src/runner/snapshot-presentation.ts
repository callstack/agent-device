import type {
  IosRunnerQualityPayloadFacts,
  IosSnapshotInput,
  IosViewportEvidence,
} from '@agent-device/contracts/ios-snapshot';
import type { SnapshotOptions } from '@agent-device/contracts/interactor-types';
import {
  IosSnapshotEngineError,
  presentIosRunnerSnapshot,
  resolveIosViewportEvidenceFromRoots,
  toIosSnapshotEngineErrorDetails,
} from '@agent-device/capture-kit/ios-snapshot-engine';
import { readSnapshotQualityVerdict } from '@agent-device/capture-kit/snapshot-quality-verdict';
import {
  createIosSnapshotRequest,
  buildIosSnapshotPresentationKey,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import { AppError } from '@agent-device/kernel/errors';
import type { RawSnapshotNode, SnapshotQualityVerdict } from '@agent-device/kernel/snapshot';

export type AppleRunnerSnapshotResult = Readonly<{
  nodes?: RawSnapshotNode[];
  truncated?: boolean;
  message?: string;
  quality?: SnapshotQualityVerdict;
  qualityPayload?: IosRunnerQualityPayloadFacts;
  runnerFatal?: boolean;
}>;

export function readAppleSnapshotResult(
  result: Record<string, unknown>,
): AppleRunnerSnapshotResult {
  return {
    nodes: Array.isArray(result.nodes) ? (result.nodes as RawSnapshotNode[]) : undefined,
    truncated: typeof result.truncated === 'boolean' ? result.truncated : undefined,
    quality: readSnapshotQualityVerdict(result.snapshotQuality),
    qualityPayload: readQualityPayload(result.qualityPayload),
    runnerFatal: result.runnerFatal === true,
    message:
      typeof result.message === 'string' && result.message.trim().length > 0
        ? result.message
        : undefined,
  };
}

export function presentAppleRunnerSnapshot(
  deviceId: string,
  options: SnapshotOptions | undefined,
  result: AppleRunnerSnapshotResult,
): RawSnapshotNode[] {
  const nodes = result.nodes ?? [];
  if (result.runnerFatal === true || (nodes.length === 0 && result.qualityPayload === undefined)) {
    return nodes;
  }

  const request = createIosSnapshotRequest({
    raw: options?.raw,
    interactiveOnly: options?.interactiveOnly,
    depth: options?.depth,
    scope: options?.scope,
    customActions: options?.customActions,
  });
  const viewport = runnerViewportEvidence(nodes, result.qualityPayload?.nodes);

  const input: IosSnapshotInput = {
    stage: 'presented',
    presentation: {
      producer: 'apple-runner',
      intent: 'full',
      payload: {
        nodes,
        truncated: result.truncated ?? false,
        ...(result.quality?.effectiveDepth !== undefined
          ? { effectiveDepth: result.quality.effectiveDepth }
          : {}),
      },
      ...(result.qualityPayload ? { qualityPayload: result.qualityPayload } : {}),
    },
    validation: {
      presentationKey: buildIosSnapshotPresentationKey(request),
      viewport,
      hittability: { kind: 'available' },
      lineage: { targetId: deviceId },
      residue: [],
    },
  };

  try {
    return presentIosRunnerSnapshot(input, request).nodes;
  } catch (error) {
    throwSnapshotEngineError(error);
  }
}

function readQualityPayload(value: unknown): IosRunnerQualityPayloadFacts | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !Array.isArray(value.nodes) || typeof value.truncated !== 'boolean') {
    throwSnapshotEngineError(
      new IosSnapshotEngineError(
        'invalid-quality-payload',
        'iOS runner returned an invalid quality payload',
      ),
    );
  }
  if (value.scope !== undefined && value.scope !== null) {
    throwSnapshotEngineError(
      new IosSnapshotEngineError(
        'invalid-quality-payload',
        'iOS runner quality payload must be unscoped',
        { field: 'scope' },
      ),
    );
  }
  return { nodes: value.nodes as RawSnapshotNode[], truncated: value.truncated, scope: null };
}

function runnerViewportEvidence(
  nodes: readonly RawSnapshotNode[],
  qualityNodes: readonly RawSnapshotNode[] | undefined,
): IosViewportEvidence {
  return (
    resolveIosViewportEvidenceFromRoots(rootNodes(qualityNodes), {
      fallbackToLargestRoot: true,
    }) ??
    resolveIosViewportEvidenceFromRoots(rootNodes(nodes), { fallbackToLargestRoot: true }) ?? {
      kind: 'missing',
      reason: 'not-provided',
    }
  );
}

function rootNodes(nodes: readonly RawSnapshotNode[] | undefined): readonly RawSnapshotNode[] {
  return nodes?.filter((node) => node.parentIndex === undefined) ?? [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function throwSnapshotEngineError(error: unknown): never {
  if (!(error instanceof IosSnapshotEngineError)) throw error;
  throw new AppError(
    'COMMAND_FAILED',
    error.message,
    toIosSnapshotEngineErrorDetails(error),
    error,
  );
}
