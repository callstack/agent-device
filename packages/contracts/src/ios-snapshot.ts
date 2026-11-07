import type {
  PresentedSurface,
  RawSnapshotNode,
  Rect,
  SnapshotNode,
  SnapshotQualityNote,
  SnapshotKeyboardBandFact,
} from '@agent-device/kernel/snapshot';
import type { SNAPSHOT_PRODUCERS } from './snapshot-producers.ts';

type SnapshotProducerRegistry = typeof SNAPSHOT_PRODUCERS;

/** The producers whose trees arrive on the iOS (`xctest`) channel, from the producer registry. */
export type IosSnapshotProducer = {
  [
    Producer in keyof SnapshotProducerRegistry
  ]: 'xctest' extends SnapshotProducerRegistry[Producer]['channels'][number] ? Producer : never;
}[keyof SnapshotProducerRegistry];

export type IosAcquisitionProducer = Exclude<IosSnapshotProducer, 'apple-runner'>;

/**
 * The iOS producers that hand over a bare tree, so capture-kit derives their residue. `apple-runner`
 * and `simulator-ax-bridge` build their own residue at the source and are absent by construction:
 * a declaration for them would have no reader (#2199).
 */
export type IosProviderAcquisitionProducer = {
  [
    Producer in IosAcquisitionProducer
  ]: (typeof SNAPSHOT_PRODUCERS)[Producer]['residue'] extends 'provider-derived' ? Producer : never;
}[IosAcquisitionProducer];
export type IosAcquisitionIntent = 'full' | 'surface-observation';
export type IosSnapshotProjection = 'regular' | 'raw';
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

export type IosSnapshotFact =
  | 'acquisition-depth'
  | 'scope'
  | 'interactive-query'
  | 'viewport'
  | 'hittability'
  | 'generation'
  | 'truncation';

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

/**
 * Why a provider left a collapsed tab bar unexpanded:
 * - `rejected`: a hit-test across the bar failed.
 * - `timed-out`: a hit-test across the bar did not answer in time.
 * - `budget-exhausted`: the hit-test budget ran out before a candidate with a tab bar's height
 *   was checked.
 */
export type IosCollapsedTabBarProbeFailure = 'rejected' | 'timed-out' | 'budget-exhausted';

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
    }>
  | Readonly<{
      kind: 'stale-generation';
      expected?: IosSnapshotGeneration;
      observed?: IosSnapshotGeneration;
    }>
  | Readonly<{
      kind: 'unknown-generation';
      captureId: string;
    }>
  | Readonly<{
      kind: 'unavailable-fact';
      fact: IosSnapshotFact;
    }>
  | Readonly<{
      kind: 'fallback-source';
      producer: IosSnapshotProducer;
    }>
  | Readonly<{
      kind: 'collapsed-tab-bar-probe-failed';
      reason: IosCollapsedTabBarProbeFailure;
    }>;

type IosSnapshotAcquisitionForIntent<Intent extends IosAcquisitionIntent> = Readonly<{
  producer: IosAcquisitionProducer;
  intent: Intent;
  hint: CaptureHint & Readonly<{ acquisitionIntent: Intent }>;
  nodes: readonly RawSnapshotNode[];
  truncated?: boolean;
  viewport: IosViewportEvidence;
  keyboard?: SnapshotKeyboardBandFact;
  lineage: IosSnapshotLineage;
  residue: readonly IosAcquisitionResidue[];
}>;

export type IosSnapshotAcquisition =
  | IosSnapshotAcquisitionForIntent<'full'>
  | IosSnapshotAcquisitionForIntent<'surface-observation'>;

export type IosSnapshotAcquisitionFacts = Omit<IosSnapshotAcquisition, 'hint'>;

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
  qualityNotes?: SnapshotQualityNote[];
  payload: IosSnapshotPublishedPayload;
  presentationKey: IosSnapshotPresentationKey;
  comparisonIdentity: IosSnapshotComparisonIdentity;
  residue: readonly IosAcquisitionResidue[];
  /**
   * The box the regular projection validated this tree against (#3182), handed over by the engine
   * that measured against it. A raw projection validates no box and carries none.
   */
  validatedViewport?: Rect;
  /**
   * Whether this capture read a modal presentation over the app (#3565), classified on the acquired
   * tree so every projection of one acquisition — interactive, full, depth-cut, scoped — answers the
   * same value. A raw `--depth` bounds the acquisition itself, so it can read too little and answer
   * `unknown`. Only an acquisition the engine itself classified carries it: a runner-declared capture
   * arrives already presented, and the runner's own reading of its pre-presentation acquisition
   * travels on the payload beside it.
   */
  presentedSurface?: PresentedSurface;
}>;

export type IosSnapshotEngine = Readonly<{
  publish(input: IosSnapshotInput, request: IosSnapshotRequest): IosSnapshotPublication;
}>;
