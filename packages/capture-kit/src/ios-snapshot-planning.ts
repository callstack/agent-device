import type {
  CaptureHint,
  IosAcquisitionResidue,
  IosSnapshotComparisonIdentity,
  IosSnapshotInput,
  IosSnapshotPresentationKey,
  IosSnapshotRequest,
  IosSnapshotRequestInput,
} from '@agent-device/contracts/ios-snapshot';

export function createIosSnapshotRequest(input: IosSnapshotRequestInput = {}): IosSnapshotRequest {
  return Object.freeze({
    projection: input.projection ?? (input.raw === true ? 'raw' : 'regular'),
    interactiveOnly: input.interactiveOnly === true,
    depth: typeof input.depth === 'number' ? input.depth : null,
    scope: input.scope?.trim() || null,
    customActions: input.customActions === true,
    acquisitionIntent: input.acquisitionIntent ?? 'full',
  });
}

export function buildIosSnapshotPresentationKey(
  request: IosSnapshotRequest,
): IosSnapshotPresentationKey {
  return Object.freeze({
    projection: request.projection,
    interactiveOnly: request.interactiveOnly,
    depth: request.depth,
    scope: request.scope,
    customActions: request.customActions,
  });
}

export function deriveIosCaptureHint(request: IosSnapshotRequest): CaptureHint {
  const isScoped = request.scope !== null;
  const isRaw = request.projection === 'raw';
  return Object.freeze({
    projection: request.projection,
    rawTraversalDepth: isRaw && !isScoped ? request.depth : null,
    regularPresentedDepth: !isRaw && !isScoped ? request.depth : null,
    interactiveOnly: !isRaw && request.interactiveOnly,
    customActions: request.customActions,
    acquisitionIntent: request.acquisitionIntent,
  });
}

export function iosSnapshotComparisonIdentityKey(identity: IosSnapshotComparisonIdentity): string {
  return JSON.stringify({
    producer: identity.producer,
    intent: identity.intent,
    lineage: identity.lineage,
    presentationKey: identity.presentationKey,
    residue: identity.residue.map(residueIdentity).sort(),
  });
}

export function buildIosSnapshotComparisonIdentity(
  input: IosSnapshotInput,
  request: IosSnapshotRequest,
): IosSnapshotComparisonIdentity {
  if (input.stage === 'acquired') {
    return Object.freeze({
      producer: input.acquisition.producer,
      intent: input.acquisition.intent,
      lineage: input.acquisition.lineage,
      presentationKey: buildIosSnapshotPresentationKey(request),
      residue: Object.freeze([...input.acquisition.residue]),
    });
  }
  return Object.freeze({
    producer: input.presentation.producer,
    intent: input.presentation.intent,
    lineage: input.validation.lineage,
    presentationKey: input.validation.presentationKey,
    residue: Object.freeze([...input.validation.residue]),
  });
}

function residueIdentity(residue: IosAcquisitionResidue): string {
  switch (residue.kind) {
    case 'provider-pruned':
      return JSON.stringify({ kind: residue.kind, fields: [...residue.fields].sort() });
    case 'missing-viewport':
      return JSON.stringify({ kind: residue.kind, reason: residue.reason });
    case 'truncated':
      return JSON.stringify({ kind: residue.kind });
    case 'stale-generation':
      return JSON.stringify({
        kind: residue.kind,
        expected: residue.expected,
        observed: residue.observed,
      });
    case 'unknown-generation':
      return JSON.stringify({ kind: residue.kind, captureId: residue.captureId });
    case 'unavailable-fact':
      return JSON.stringify({ kind: residue.kind, fact: residue.fact });
    case 'fallback-source':
      return JSON.stringify({ kind: residue.kind, producer: residue.producer });
  }
}
