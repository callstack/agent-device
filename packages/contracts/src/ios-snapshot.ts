import type { RawSnapshotNode, Rect, SnapshotNode } from '@agent-device/kernel/snapshot';

export type IosSnapshotProducer =
  | 'apple-runner'
  | 'simulator-ax-bridge'
  | 'appium-source'
  | 'limrun-ios-tree';

export type IosAcquisitionProducer = Exclude<IosSnapshotProducer, 'apple-runner'>;
export type IosAcquisitionIntent = 'full' | 'surface-observation';
export type IosSnapshotProjection = 'regular' | 'raw';
export type IosSnapshotCompleteness = 'complete' | 'incomplete';
export type IosSnapshotEvidenceAvailability = 'available' | 'unavailable';
export type IosSnapshotPresentationOwner = 'ios-snapshot-engine' | 'snapshot-state';

export type IosSnapshotGeneration = string;

export type IosSnapshotLineage = Readonly<{
  targetId?: string;
  generation?: IosSnapshotGeneration;
}>;

export type IosSnapshotPresentationKey = Readonly<{
  projection: IosSnapshotProjection;
  interactiveOnly: boolean;
  depth: number | null;
  scope: string | null;
  customActions: boolean;
}>;

export type IosSnapshotRequest = Readonly<{
  projection: IosSnapshotProjection;
  interactiveOnly: boolean;
  depth: number | null;
  scope: string | null;
  customActions: boolean;
  acquisitionIntent: IosAcquisitionIntent;
}>;

export type IosSnapshotRequestInput = Readonly<{
  projection?: IosSnapshotProjection;
  raw?: boolean;
  interactiveOnly?: boolean;
  depth?: number | null;
  scope?: string | null;
  customActions?: boolean;
  acquisitionIntent?: IosAcquisitionIntent;
}>;

export type CaptureHint = Readonly<{
  projection: IosSnapshotProjection;
  rawTraversalDepth: number | null;
  regularPresentedDepth: number | null;
  interactiveOnly: boolean;
  customActions: boolean;
  acquisitionIntent: IosAcquisitionIntent;
}>;

export type IosSnapshotDepthSupport =
  | Readonly<{ kind: 'complete'; maxDepth?: number }>
  | Readonly<{ kind: 'incomplete' }>
  | Readonly<{ kind: 'not-applicable' }>;

export type IosSnapshotAcquisitionDepthCapability = Readonly<{
  rawTraversal: IosSnapshotDepthSupport;
  regularPresented: IosSnapshotDepthSupport;
}>;

export type IosSnapshotFact =
  | 'acquisition-depth'
  | 'scope'
  | 'interactive-query'
  | 'viewport'
  | 'hittability'
  | 'generation'
  | 'truncation';

type IosSnapshotProducerCapabilityFacts = Readonly<{
  acquisitionDepth: IosSnapshotAcquisitionDepthCapability;
  scopeCompleteness: IosSnapshotCompleteness;
  interactiveQueryCompleteness: IosSnapshotCompleteness;
  viewportEvidence: IosSnapshotEvidenceAvailability;
  hittabilityEvidence: IosSnapshotEvidenceAvailability;
  presentationOwner: IosSnapshotPresentationOwner;
}>;

export type IosSnapshotAcquisitionProducerCapabilities = IosSnapshotProducerCapabilityFacts &
  Readonly<{
    producer: IosAcquisitionProducer;
    stage: 'acquired';
  }>;

export type IosSnapshotPresentedProducerCapabilities = IosSnapshotProducerCapabilityFacts &
  Readonly<{
    producer: 'apple-runner';
    stage: 'presented';
  }>;

export type IosSnapshotProducerCapabilities =
  | IosSnapshotAcquisitionProducerCapabilities
  | IosSnapshotPresentedProducerCapabilities;

export type IosViewportEvidence =
  | Readonly<{ kind: 'reported'; rect: Rect }>
  | Readonly<{ kind: 'derived'; rect: Rect }>
  | Readonly<{
      kind: 'missing';
      reason: 'not-provided' | 'not-supported' | 'invalid';
    }>;

export type IosHittabilityEvidence =
  | Readonly<{ kind: 'available' }>
  | Readonly<{
      kind: 'unavailable';
      reason: 'not-provided' | 'not-supported' | 'partial';
    }>;

export type IosProviderPrunedField = 'nodes' | 'depth' | 'scope' | 'interactive-only';
export type IosTruncationDimension = 'nodes' | 'depth' | 'payload';

export type IosAcquisitionResidue =
  | Readonly<{
      kind: 'provider-pruned';
      fields: readonly IosProviderPrunedField[];
    }>
  | Readonly<{
      kind: 'missing-viewport';
      reason: 'not-provided' | 'not-supported' | 'invalid';
    }>
  | Readonly<{
      kind: 'truncated';
      dimension: IosTruncationDimension;
      limit?: number;
    }>
  | Readonly<{
      kind: 'stale-generation';
      expected?: IosSnapshotGeneration;
      observed?: IosSnapshotGeneration;
    }>
  | Readonly<{
      kind: 'unavailable-fact';
      fact: IosSnapshotFact;
    }>
  | Readonly<{
      kind: 'fallback-source';
      producer: IosSnapshotProducer;
    }>;

type IosSnapshotAcquisitionForIntent<Intent extends IosAcquisitionIntent> = Readonly<{
  producer: IosAcquisitionProducer;
  intent: Intent;
  hint: CaptureHint & Readonly<{ acquisitionIntent: Intent }>;
  nodes: readonly RawSnapshotNode[];
  truncated?: boolean;
  viewport: IosViewportEvidence;
  lineage: IosSnapshotLineage;
  residue: readonly IosAcquisitionResidue[];
}>;

export type IosSnapshotAcquisition =
  | IosSnapshotAcquisitionForIntent<'full'>
  | IosSnapshotAcquisitionForIntent<'surface-observation'>;

export type IosRunnerPayloadFacts = Readonly<{
  nodes: readonly RawSnapshotNode[];
  truncated: boolean;
  effectiveDepth?: number;
}>;

export type IosRunnerQualityPayloadFacts = IosRunnerPayloadFacts &
  Readonly<{
    scope: null;
  }>;

export type IosRunnerPresentation = Readonly<{
  producer: 'apple-runner';
  intent: IosAcquisitionIntent;
  payload: IosRunnerPayloadFacts;
  qualityPayload?: IosRunnerQualityPayloadFacts;
}>;

export type IosSnapshotValidationFacts = Readonly<{
  presentationKey: IosSnapshotPresentationKey;
  viewport: IosViewportEvidence;
  hittability: IosHittabilityEvidence;
  lineage: IosSnapshotLineage;
  residue: readonly IosAcquisitionResidue[];
}>;

export type IosSnapshotInput =
  | Readonly<{
      stage: 'acquired';
      acquisition: IosSnapshotAcquisition;
    }>
  | Readonly<{
      stage: 'presented';
      presentation: IosRunnerPresentation;
      validation: IosSnapshotValidationFacts;
    }>;

export type IosSnapshotAcquisitionNarrowing = Readonly<{
  depth: number | null;
  scope: null;
  interactiveOnly: boolean;
}>;

export type IosSnapshotPlan = Readonly<{
  request: IosSnapshotRequest;
  producer: IosSnapshotProducer;
  hint: CaptureHint;
  narrowing: IosSnapshotAcquisitionNarrowing;
  evidence: Readonly<{
    scope: IosSnapshotCompleteness;
    interactiveQuery: IosSnapshotCompleteness;
    viewport: IosSnapshotEvidenceAvailability;
    hittability: IosSnapshotEvidenceAvailability;
  }>;
}>;

export type IosSnapshotPublishedPayload = Readonly<{
  nodes: readonly SnapshotNode[];
  truncated?: boolean;
}>;

export type IosSnapshotComparisonIdentity = Readonly<{
  producer: IosSnapshotProducer;
  intent: IosAcquisitionIntent;
  lineage: IosSnapshotLineage;
  presentationKey: IosSnapshotPresentationKey;
  residue: readonly IosAcquisitionResidue[];
}>;

export type IosSnapshotPublication = Readonly<{
  payload: IosSnapshotPublishedPayload;
  presentationKey: IosSnapshotPresentationKey;
  comparisonIdentity: IosSnapshotComparisonIdentity;
  residue: readonly IosAcquisitionResidue[];
}>;

export type IosSnapshotEngine = Readonly<{
  plan(request: IosSnapshotRequest, producer: IosSnapshotProducerCapabilities): IosSnapshotPlan;
  publish(input: IosSnapshotInput, request: IosSnapshotRequest): IosSnapshotPublication;
}>;
