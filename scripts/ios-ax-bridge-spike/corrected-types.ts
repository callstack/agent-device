import type { SpikeCell, SpikeReport, SpikeRequest, SpikeResponse } from './types.ts';

const CORRECTED_SCHEMA_VERSION = 'ios-simulator-ax-bridge-corrected.v1' as const;
export const TARGETED_SCHEMA_VERSION = 'ios-simulator-ax-bridge-targeted.v1' as const;

export type TargetedRevision = SpikeReport['revision'];

export type TargetedBootstrapSample = Readonly<{
  index: number;
  durationMs: number;
  usableTree: boolean;
  response: SpikeResponse;
  stderr: string;
}>;

export type TargetedRecoveryProbe = Readonly<{
  operation: 'process-crash' | 'timeout' | 'cancelled' | 'stale-generation';
  request: SpikeRequest;
  response: SpikeResponse;
  recoveredResponse: SpikeResponse;
}>;

export type TargetedRawArtifact = Readonly<{
  schemaVersion: typeof TARGETED_SCHEMA_VERSION;
  generatedAt: string;
  revision: TargetedRevision;
  command: string;
  sourceArtifact: Readonly<{ path: string; revision: TargetedRevision }>;
  target: SpikeReport['target'];
  toolchain: SpikeReport['toolchain'];
  guestMechanism: SpikeReport['guestMechanism'];
  preferenceEvidence: SpikeReport['preferenceEvidence'];
  config: Readonly<{
    states: readonly SpikeCell['state'][];
    screens: readonly SpikeCell['screen'][];
    samples: number;
    bootstrapSamples: number;
  }>;
  bootstrap: readonly TargetedBootstrapSample[];
  recovery: readonly TargetedRecoveryProbe[];
  simulator: Readonly<{ finalState: string; accessibilityPlistSha256: string }>;
}>;

export type LatencySummary = Readonly<{
  state: 'warm' | 'relaunch';
  screen: SpikeCell['screen'];
  samples: number;
  readableSamples: number;
  readinessObservedSamples: number;
  generationCount: number;
  candidateP50Ms: number | null;
  candidateP95Ms: number | null;
  preparationP95Ms: number | null;
  firstLookP95Ms: number | null;
}>;

export type GateResult = Readonly<{
  status: 'PASS' | 'FAIL';
  target: string;
  evidence: string;
}>;

export type CorrectedReport = Readonly<{
  schemaVersion: typeof CORRECTED_SCHEMA_VERSION;
  interpretation: 'maintainer-corrected';
  generatedAt: string;
  revision: TargetedRevision;
  sourceArtifact: Readonly<{
    path: string;
    revision: TargetedRevision;
    originalDecision: 'NO-GO';
    interpretation: 'superseded-stretch-only';
  }>;
  targetedArtifact: Readonly<{ path: string; revision: TargetedRevision }>;
  target: SpikeReport['target'];
  toolchain: SpikeReport['toolchain'];
  guestMechanism: SpikeReport['guestMechanism'];
  readiness: readonly LatencySummary[];
  hardGates: Readonly<{
    warm: GateResult;
    relaunch: GateResult;
    nonresidentBootstrap: GateResult;
    liveRecovery: GateResult;
    hierarchyResidue: GateResult;
  }>;
  coldDiagnostics: readonly Readonly<{
    state: 'cold-cold' | 'cold';
    screen: SpikeCell['screen'];
    preparationP95Ms: number | null;
    firstLookP95Ms: number | null;
    interpretation: 'excluded-runner-and-app-readiness-costs';
  }>[];
  stretchFindings: readonly string[];
  decision: 'GO' | 'NO-GO';
  decisionReasons: readonly string[];
  liveRecovery: readonly TargetedRecoveryProbe[];
  bootstrap: readonly TargetedBootstrapSample[];
  hierarchy: Readonly<{
    residue: Readonly<{ kind: 'provider-pruned'; fields: readonly ['depth'] }>;
    observedTraversalDepth: number;
    depthComplete: false;
    interpretation: 'flat-provider-response';
  }>;
  productionBoundary: 'no-production-routing-changes';
}>;
