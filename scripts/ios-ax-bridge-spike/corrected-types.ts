import type {
  ResourceLimits,
  SpikeCell,
  SpikeReport,
  SpikeRequest,
  SpikeResponse,
} from './types.ts';

const CORRECTED_SCHEMA_VERSION = 'ios-simulator-ax-bridge-corrected.v3' as const;
export const TARGETED_SCHEMA_VERSION = 'ios-simulator-ax-bridge-targeted.v3' as const;

export type TargetedRevision = SpikeReport['revision'];

export type HostLoad = Readonly<{ loadAverage1m: number; cpuCores: number }>;

export type TargetedBootstrapSample = Readonly<{
  index: number;
  /** Candidate-owned: fresh guest spawn + connect + first usable tree, after readiness. */
  durationMs: number;
  usableTree: boolean;
  response: SpikeResponse;
  stderr: string;
  /** Fixture-owned: app relaunch until a throwaway probe first read a tree; not charged. */
  appPid: number;
  readinessMs: number;
  readinessAttempts: number;
  host: HostLoad;
}>;

export type TargetedRecoveryProbe = Readonly<{
  operation: 'process-crash' | 'timeout' | 'cancelled' | 'stale-generation';
  request: SpikeRequest;
  response: SpikeResponse;
  recoveredResponse: SpikeResponse;
}>;

export type TargetedRelaunchSample = Readonly<{
  index: number;
  screen: SpikeCell['screen'];
  expectedAnchor: string;
  appPid: number;
  readinessMs: number;
  readinessAttempts: number;
  durationMs: number;
  response: SpikeResponse;
  stderr: string;
}>;

export type TargetedRawArtifact = Readonly<{
  schemaVersion: typeof TARGETED_SCHEMA_VERSION;
  generatedAt: string;
  revision: TargetedRevision;
  command: string;
  sourceArtifact: Readonly<{
    path: string;
    revision: TargetedRevision;
    hostClient: string;
  }>;
  target: SpikeReport['target'];
  toolchain: SpikeReport['toolchain'];
  host: HostLoad;
  guestMechanism: SpikeReport['guestMechanism'];
  limits: ResourceLimits;
  config: Readonly<{
    states: readonly SpikeCell['state'][];
    screens: readonly SpikeCell['screen'][];
    samples: number;
    bootstrapSamples: number;
  }>;
  bootstrap: readonly TargetedBootstrapSample[];
  relaunch: readonly TargetedRelaunchSample[];
  recovery: readonly TargetedRecoveryProbe[];
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
    hostClient: string;
  }>;
  targetedArtifact: Readonly<{ path: string; revision: TargetedRevision }>;
  target: SpikeReport['target'];
  toolchain: SpikeReport['toolchain'];
  host: HostLoad;
  guestMechanism: SpikeReport['guestMechanism'];
  readiness: readonly LatencySummary[];
  hardGates: Readonly<{
    warm: GateResult;
    relaunch: GateResult;
    nonresidentBootstrap: GateResult;
    boundedResources: GateResult;
    liveRecovery: GateResult;
    hierarchy: GateResult;
    preferenceControl: GateResult;
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
    observedTraversalDepth: number;
    depthComplete: boolean;
    interpretation: 'nested-tree' | 'flat-provider-response' | 'not-observed';
  }>;
  compatibilityRisk: Readonly<{
    interface: 'private-idb-simulator-guest';
    assessment: string;
    control: string;
  }>;
  productionBoundary: 'no-production-routing-changes';
}>;
