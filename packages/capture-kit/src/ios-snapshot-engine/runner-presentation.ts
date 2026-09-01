import { buildIosSnapshotPresentationKey } from '../ios-snapshot-planning.ts';
import type { IosSnapshotInput, IosSnapshotRequest } from '@agent-device/contracts/ios-snapshot';
import type { Rect, RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { buildIosInteractiveSnapshotPresentation } from './semantic-index.ts';
import { resolveViewportEvidence, validateIosPayload } from './invariants.ts';
import type { IosSnapshotEnginePresentation, IosSnapshotFoldPolicy } from './types.ts';
import { IosSnapshotEngineError } from './types.ts';

export function presentIosRunnerSnapshot(
  input: Extract<IosSnapshotInput, { stage: 'presented' }>,
  request: IosSnapshotRequest,
  foldPolicy: IosSnapshotFoldPolicy = 'cursor-projected',
): IosSnapshotEnginePresentation {
  validateRunnerRequest(input, request);
  const projection = input.validation.presentationKey.projection;
  const viewport =
    projection === 'regular' ? resolveViewportEvidence(input.validation.viewport) : undefined;
  const hittabilityAvailable = input.validation.hittability.kind === 'available';
  const payloadValidation = validateRunnerPayloads(
    input,
    projection,
    viewport,
    foldPolicy,
    hittabilityAvailable,
  );
  const compacted = compactRunnerPayload(input.presentation.payload.nodes, projection, request);
  const validationStats = validateRunnerOutput(
    compacted.nodes,
    projection,
    viewport,
    foldPolicy,
    hittabilityAvailable,
    payloadValidation,
  );
  return {
    nodes: compacted.nodes,
    ...(input.presentation.qualityPayload
      ? { qualityNodes: [...input.presentation.qualityPayload.nodes] }
      : {}),
    presentedIndexesBySourceIndex: compacted.presentedIndexesBySourceIndex,
    stats: {
      presentedNodeCount: compacted.nodes.length,
      sourceNodeCount: input.presentation.payload.nodes.length,
      parentClipLookups: validationStats.parentClipLookups,
    },
  };
}

function validateRunnerRequest(
  input: Extract<IosSnapshotInput, { stage: 'presented' }>,
  request: IosSnapshotRequest,
): void {
  const expectedKey = buildIosSnapshotPresentationKey(request);
  if (!presentationKeysEqual(expectedKey, input.validation.presentationKey)) {
    throw new IosSnapshotEngineError(
      'projection-mismatch',
      'presented iOS snapshot does not match the requested presentation key',
      { projection: input.validation.presentationKey.projection },
    );
  }
  if (input.presentation.intent !== request.acquisitionIntent) {
    throw new IosSnapshotEngineError(
      'projection-mismatch',
      'presented iOS snapshot does not match the requested acquisition intent',
      { field: 'acquisitionIntent' },
    );
  }
}

function validateRunnerPayloads(
  input: Extract<IosSnapshotInput, { stage: 'presented' }>,
  projection: 'regular' | 'raw',
  viewport: Rect | undefined,
  foldPolicy: IosSnapshotFoldPolicy,
  hittabilityAvailable: boolean,
): { parentClipLookups: number } {
  const payloadValidation = validateIosPayload(
    input.presentation.payload.nodes,
    projection,
    viewport,
    foldPolicy,
    hittabilityAvailable,
  );
  if (input.presentation.qualityPayload) {
    try {
      validateIosPayload(
        input.presentation.qualityPayload.nodes,
        projection,
        viewport,
        foldPolicy,
        hittabilityAvailable,
      );
    } catch (error) {
      if (error instanceof IosSnapshotEngineError) {
        throw new IosSnapshotEngineError('invalid-quality-payload', error.message, error.details);
      }
      /* c8 ignore next */
      throw error;
    }
  }
  return payloadValidation;
}

function compactRunnerPayload(
  nodes: readonly RawSnapshotNode[],
  projection: 'regular' | 'raw',
  request: IosSnapshotRequest,
): ReturnType<typeof buildIosInteractiveSnapshotPresentation> {
  if (projection === 'regular' && request.interactiveOnly) {
    return buildIosInteractiveSnapshotPresentation([...nodes]);
  }
  return {
    nodes: [...nodes],
    presentedIndexesBySourceIndex: identityMapping(nodes),
  };
}

function validateRunnerOutput(
  nodes: readonly RawSnapshotNode[],
  projection: 'regular' | 'raw',
  viewport: Rect | undefined,
  foldPolicy: IosSnapshotFoldPolicy,
  hittabilityAvailable: boolean,
  payloadValidation: { parentClipLookups: number },
): { parentClipLookups: number } {
  if (projection !== 'regular' || !viewport) return payloadValidation;
  return validateIosPayload(nodes, projection, viewport, foldPolicy, hittabilityAvailable);
}

function presentationKeysEqual(
  left: ReturnType<typeof buildIosSnapshotPresentationKey>,
  right: ReturnType<typeof buildIosSnapshotPresentationKey>,
): boolean {
  return (
    left.projection === right.projection &&
    left.interactiveOnly === right.interactiveOnly &&
    left.depth === right.depth &&
    left.scope === right.scope &&
    left.customActions === right.customActions
  );
}

function identityMapping(
  nodes: readonly RawSnapshotNode[],
): ReadonlyMap<number, readonly number[]> {
  return new Map(nodes.map((node) => [node.index, [node.index]]));
}
