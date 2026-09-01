import type {
  CaptureHint,
  IosAcquisitionResidue,
  IosSnapshotAcquisitionDepthCapability,
  IosSnapshotComparisonIdentity,
  IosSnapshotInput,
  IosSnapshotPlan,
  IosSnapshotPresentationKey,
  IosSnapshotProducer,
  IosSnapshotProducerCapabilities,
  IosSnapshotRequest,
  IosSnapshotRequestInput,
} from '@agent-device/contracts/ios-snapshot';

const IOS_SNAPSHOT_PRODUCER_CAPABILITY_VALUES = {
  'apple-runner': {
    producer: 'apple-runner',
    stage: 'presented',
    acquisitionDepth: {
      rawTraversal: { kind: 'not-applicable' },
      regularPresented: { kind: 'not-applicable' },
    },
    scopeCompleteness: 'complete',
    interactiveQueryCompleteness: 'complete',
    viewportEvidence: 'available',
    hittabilityEvidence: 'available',
    presentationOwner: 'ios-snapshot-engine',
  },
  'simulator-ax-bridge': {
    producer: 'simulator-ax-bridge',
    stage: 'acquired',
    acquisitionDepth: {
      rawTraversal: { kind: 'complete' },
      regularPresented: { kind: 'incomplete' },
    },
    scopeCompleteness: 'incomplete',
    interactiveQueryCompleteness: 'incomplete',
    viewportEvidence: 'available',
    hittabilityEvidence: 'available',
    presentationOwner: 'snapshot-state',
  },
  'appium-source': {
    producer: 'appium-source',
    stage: 'acquired',
    acquisitionDepth: {
      rawTraversal: { kind: 'incomplete' },
      regularPresented: { kind: 'incomplete' },
    },
    scopeCompleteness: 'incomplete',
    interactiveQueryCompleteness: 'incomplete',
    viewportEvidence: 'available',
    hittabilityEvidence: 'unavailable',
    presentationOwner: 'ios-snapshot-engine',
  },
  'limrun-ios-tree': {
    producer: 'limrun-ios-tree',
    stage: 'acquired',
    acquisitionDepth: {
      rawTraversal: { kind: 'complete' },
      regularPresented: { kind: 'incomplete' },
    },
    scopeCompleteness: 'incomplete',
    interactiveQueryCompleteness: 'incomplete',
    viewportEvidence: 'available',
    hittabilityEvidence: 'unavailable',
    presentationOwner: 'snapshot-state',
  },
} as const satisfies Record<IosSnapshotProducer, IosSnapshotProducerCapabilities>;

export const IOS_SNAPSHOT_PRODUCER_CAPABILITIES: Readonly<
  Record<IosSnapshotProducer, IosSnapshotProducerCapabilities>
> = Object.freeze(IOS_SNAPSHOT_PRODUCER_CAPABILITY_VALUES);

export function deriveIosSnapshotCapabilityResidue(
  producer: IosSnapshotProducerCapabilities,
): readonly IosAcquisitionResidue[] {
  const residue: IosAcquisitionResidue[] = [];
  if (producer.hittabilityEvidence === 'unavailable') {
    residue.push({ kind: 'unavailable-fact', fact: 'hittability' });
  }
  if (
    producer.stage === 'acquired' &&
    (producer.acquisitionDepth.rawTraversal.kind === 'incomplete' ||
      producer.acquisitionDepth.regularPresented.kind === 'incomplete')
  ) {
    residue.push({ kind: 'unavailable-fact', fact: 'acquisition-depth' });
  }
  return Object.freeze(residue);
}

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

export function planIosSnapshot(
  request: IosSnapshotRequest,
  producer: IosSnapshotProducerCapabilities,
): IosSnapshotPlan {
  const hint = deriveIosCaptureHint(request);
  const requestedDepth = hint.rawTraversalDepth ?? hint.regularPresentedDepth;
  const depthSupport = depthSupportFor(request, producer);
  const depth =
    requestedDepth !== null && isCompleteFor(depthSupport, requestedDepth) ? requestedDepth : null;
  const interactiveOnly =
    producer.stage === 'acquired' &&
    hint.interactiveOnly &&
    producer.interactiveQueryCompleteness === 'complete' &&
    producer.hittabilityEvidence === 'available';

  return Object.freeze({
    request,
    producer: producer.producer,
    hint,
    narrowing: Object.freeze({ depth, scope: null, interactiveOnly }),
    evidence: Object.freeze({
      scope: producer.scopeCompleteness,
      interactiveQuery: producer.interactiveQueryCompleteness,
      viewport: producer.viewportEvidence,
      hittability: producer.hittabilityEvidence,
    }),
  });
}

export function areIosSnapshotComparisonIdentitiesEqual(
  left: IosSnapshotComparisonIdentity,
  right: IosSnapshotComparisonIdentity,
): boolean {
  return (
    left.producer === right.producer &&
    left.intent === right.intent &&
    lineagesEqual(left.lineage, right.lineage) &&
    presentationKeysEqual(left.presentationKey, right.presentationKey) &&
    residuesEqual(left.residue, right.residue)
  );
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

function depthSupportFor(
  request: IosSnapshotRequest,
  producer: IosSnapshotProducerCapabilities,
): IosSnapshotAcquisitionDepthCapability['rawTraversal'] {
  if (producer.stage !== 'acquired') return { kind: 'not-applicable' };
  return request.projection === 'raw'
    ? producer.acquisitionDepth.rawTraversal
    : producer.acquisitionDepth.regularPresented;
}

function isCompleteFor(
  support: IosSnapshotAcquisitionDepthCapability['rawTraversal'],
  requestedDepth: number,
): boolean {
  return (
    support.kind === 'complete' &&
    (support.maxDepth === undefined || requestedDepth <= support.maxDepth)
  );
}

function lineagesEqual(
  left: IosSnapshotComparisonIdentity['lineage'],
  right: IosSnapshotComparisonIdentity['lineage'],
): boolean {
  return left.targetId === right.targetId && left.generation === right.generation;
}

function presentationKeysEqual(
  left: IosSnapshotPresentationKey,
  right: IosSnapshotPresentationKey,
): boolean {
  return (
    left.projection === right.projection &&
    left.interactiveOnly === right.interactiveOnly &&
    left.depth === right.depth &&
    left.scope === right.scope &&
    left.customActions === right.customActions
  );
}

function residuesEqual(
  left: readonly IosAcquisitionResidue[],
  right: readonly IosAcquisitionResidue[],
): boolean {
  return (
    left.map(residueIdentity).sort().join('\u0000') ===
    right.map(residueIdentity).sort().join('\u0000')
  );
}

function residueIdentity(residue: IosAcquisitionResidue): string {
  switch (residue.kind) {
    case 'provider-pruned':
      return JSON.stringify({ kind: residue.kind, fields: [...residue.fields].sort() });
    case 'missing-viewport':
      return JSON.stringify({ kind: residue.kind, reason: residue.reason });
    case 'truncated':
      return JSON.stringify({
        kind: residue.kind,
        dimension: residue.dimension,
        limit: residue.limit,
      });
    case 'stale-generation':
      return JSON.stringify({
        kind: residue.kind,
        expected: residue.expected,
        observed: residue.observed,
      });
    case 'unavailable-fact':
      return JSON.stringify({ kind: residue.kind, fact: residue.fact });
    case 'fallback-source':
      return JSON.stringify({ kind: residue.kind, producer: residue.producer });
  }
}
