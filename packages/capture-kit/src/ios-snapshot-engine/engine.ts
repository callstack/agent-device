import {
  buildIosSnapshotComparisonIdentity,
  buildIosSnapshotPresentationKey,
  deriveIosCaptureHint,
  IOS_SNAPSHOT_PRODUCER_CAPABILITIES,
  planIosSnapshot,
} from '../ios-snapshot-planning.ts';
import type {
  IosSnapshotAcquisition,
  IosSnapshotEngine,
  IosSnapshotInput,
  IosSnapshotPublication,
  IosSnapshotRequest,
} from '@agent-device/contracts/ios-snapshot';
import { attachRefs, type RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { buildIosInteractiveSnapshotPresentation } from './semantic-index.ts';
import { validateIosSnapshotGraph } from './graph.ts';
import { foldIosSnapshot } from './geometry.ts';
import { resolveIosViewport, validateIosPayload } from './invariants.ts';
import { projectIosQualitySnapshot, projectIosSnapshot } from './projection.ts';
import { presentIosRunnerSnapshot } from './runner-presentation.ts';
import type {
  IosSnapshotEngineOptions,
  IosSnapshotEnginePresentation,
  IosSnapshotFoldPolicy,
} from './types.ts';
import { IosSnapshotEngineError } from './types.ts';

const DEFAULT_FOLD_POLICY: IosSnapshotFoldPolicy = 'cursor-projected';

export function createIosSnapshotEngine(options: IosSnapshotEngineOptions = {}): IosSnapshotEngine {
  const foldPolicy = options.foldPolicy ?? DEFAULT_FOLD_POLICY;
  return Object.freeze({
    plan: planIosSnapshot,
    publish: (input, request) => publishIosSnapshot(input, request, { foldPolicy }),
  });
}

export function publishIosSnapshot(
  input: IosSnapshotInput,
  request: IosSnapshotRequest,
  options: IosSnapshotEngineOptions = {},
): IosSnapshotPublication {
  const presentation = presentIosSnapshot(input, request, options);
  const presentationKey =
    input.stage === 'presented'
      ? input.validation.presentationKey
      : buildIosSnapshotPresentationKey(request);
  return {
    payload: {
      nodes: attachRefs(presentation.nodes),
      truncated:
        input.stage === 'acquired'
          ? input.acquisition.truncated
          : input.presentation.payload.truncated,
    },
    presentationKey,
    comparisonIdentity: buildIosSnapshotComparisonIdentity(input, request),
    residue:
      input.stage === 'acquired' ? [...input.acquisition.residue] : [...input.validation.residue],
  };
}

export function presentIosSnapshot(
  input: IosSnapshotInput,
  request: IosSnapshotRequest,
  options: IosSnapshotEngineOptions = {},
): IosSnapshotEnginePresentation {
  const foldPolicy = options.foldPolicy ?? DEFAULT_FOLD_POLICY;
  if (input.stage === 'acquired') {
    return presentAcquiredSnapshot(input.acquisition, request, foldPolicy);
  }
  return presentIosRunnerSnapshot(input, request, foldPolicy);
}

export function compactIosInteractiveSnapshot(nodes: RawSnapshotNode[]): RawSnapshotNode[] {
  return buildIosInteractiveSnapshotPresentation(nodes).nodes;
}

function presentAcquiredSnapshot(
  acquisition: IosSnapshotAcquisition,
  request: IosSnapshotRequest,
  foldPolicy: IosSnapshotFoldPolicy,
): IosSnapshotEnginePresentation {
  const expectedHint = deriveIosCaptureHint(request);
  assertCaptureHintMatches(acquisition, expectedHint);

  if (request.projection === 'raw') {
    validateIosSnapshotGraph(acquisition.nodes);
    const sourceNodes = acquisition.nodes.map((raw) => ({ raw, sourceIndex: raw.index }));
    const projected = projectIosSnapshot({
      nodes: sourceNodes,
      projection: 'raw',
      scope: request.scope,
      depth: request.depth,
      foldPolicy,
    });
    const qualityNodes =
      request.scope === null
        ? undefined
        : projectIosQualitySnapshot({
            nodes: sourceNodes,
            projection: 'raw',
            depth: null,
            foldPolicy,
          }).nodes;
    return {
      nodes: projected.nodes,
      ...(qualityNodes ? { qualityNodes } : {}),
      presentedIndexesBySourceIndex: remapPresentedIndexes(
        acquisition.nodes,
        projected.nodes,
        projected.sourceIndexes,
        identityMapping(projected.nodes),
      ),
      stats: {
        presentedNodeCount: projected.nodes.length,
        sourceNodeCount: acquisition.nodes.length,
        parentClipLookups: 0,
      },
    };
  }

  const viewport = resolveIosViewport(acquisition);
  const hittabilityAvailable =
    IOS_SNAPSHOT_PRODUCER_CAPABILITIES[acquisition.producer].hittabilityEvidence === 'available' &&
    !hasUnavailableHittability(acquisition.residue);
  const folded = foldIosSnapshot(acquisition.nodes, viewport, request.interactiveOnly, foldPolicy, {
    hittabilityAvailable,
  });
  const foldedInput = {
    nodes: folded.nodes,
    projection: 'regular' as const,
    scope: request.scope,
    depth: request.depth,
    foldPolicy,
  };
  const projected = projectIosSnapshot(foldedInput);
  const compacted = request.interactiveOnly
    ? buildIosInteractiveSnapshotPresentation(projected.nodes)
    : {
        nodes: projected.nodes,
        presentedIndexesBySourceIndex: identityMapping(projected.nodes),
      };
  const validation = validateIosPayload(
    compacted.nodes,
    'regular',
    viewport,
    foldPolicy,
    hittabilityAvailable,
  );
  const qualityNodes =
    request.scope === null
      ? undefined
      : projectIosQualitySnapshot({
          nodes: folded.nodes,
          projection: 'regular',
          depth: null,
          foldPolicy,
        }).nodes;
  return {
    nodes: compacted.nodes,
    ...(qualityNodes ? { qualityNodes } : {}),
    presentedIndexesBySourceIndex: remapPresentedIndexes(
      acquisition.nodes,
      projected.nodes,
      projected.sourceIndexes,
      compacted.presentedIndexesBySourceIndex,
    ),
    stats: {
      presentedNodeCount: compacted.nodes.length,
      sourceNodeCount: acquisition.nodes.length,
      parentClipLookups: folded.stats.parentClipLookups + validation.parentClipLookups,
    },
  };
}

function hasUnavailableHittability(residue: IosSnapshotAcquisition['residue']): boolean {
  return residue.some((entry) => entry.kind === 'unavailable-fact' && entry.fact === 'hittability');
}

function assertCaptureHintMatches(
  acquisition: IosSnapshotAcquisition,
  expected: ReturnType<typeof deriveIosCaptureHint>,
): void {
  const actual = acquisition.hint;
  if (
    actual.projection !== expected.projection ||
    actual.rawTraversalDepth !== expected.rawTraversalDepth ||
    actual.regularPresentedDepth !== expected.regularPresentedDepth ||
    actual.interactiveOnly !== expected.interactiveOnly ||
    actual.customActions !== expected.customActions ||
    actual.acquisitionIntent !== expected.acquisitionIntent
  ) {
    throw new IosSnapshotEngineError(
      'projection-mismatch',
      'acquired iOS snapshot does not match the requested capture hint',
      { projection: actual.projection },
    );
  }
}

function identityMapping(
  nodes: readonly RawSnapshotNode[],
): ReadonlyMap<number, readonly number[]> {
  return new Map(nodes.map((node) => [node.index, [node.index]]));
}

function remapPresentedIndexes(
  sourceNodes: readonly RawSnapshotNode[],
  projectedNodes: readonly RawSnapshotNode[],
  sourceIndexes: readonly number[],
  presentedIndexesByProjectedIndex: ReadonlyMap<number, readonly number[]>,
): ReadonlyMap<number, readonly number[]> {
  const sourceIndexByProjectedIndex = new Map(
    projectedNodes.map((node, position) => [node.index, sourceIndexes[position]!]),
  );
  const remapped = new Map<number, readonly number[]>(
    sourceNodes.map((node) => [node.index, []] as const),
  );
  for (const [projectedIndex, presentedIndexes] of presentedIndexesByProjectedIndex) {
    const sourceIndex = sourceIndexByProjectedIndex.get(projectedIndex);
    if (sourceIndex !== undefined) {
      remapped.set(sourceIndex, presentedIndexes);
    }
  }
  return remapped;
}
