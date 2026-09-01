import type {
  IosAcquisitionResidue,
  IosViewportEvidence,
} from '@agent-device/contracts/ios-snapshot';
import type { DeepButtonEvidence, LocalState, ScreenId } from '../ios-snapshot-benchmark/types.ts';

export const SPIKE_SCHEMA_VERSION = 'ios-simulator-ax-bridge-spike.v1' as const;
export const SPIKE_ISSUE = '#2192' as const;
export const SPIKE_PARENT = '#2188' as const;
export const SPIKE_PREREQUISITES = ['#2189', '#2190'] as const;

export type CandidateId = 'public-macos-ax' | 'private-coresimulator-ax' | 'xctest-control';

export type SpikeFailureKind =
  | 'unsupported-mechanism'
  | 'malformed-tree'
  | 'stale-generation'
  | 'timeout'
  | 'cancelled'
  | 'process-crash'
  | 'transport-failure';

export type SpikeFailure = Readonly<{
  kind: SpikeFailureKind;
  code?: string;
  expectedTargetGeneration?: string;
  observedTargetGeneration?: string;
}>;

export type SpikeRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type RawAcquiredNode = Readonly<{
  id: string;
  type?: string;
  parentId?: string;
  role?: string;
  subrole?: string;
  label?: string;
  value?: string;
  identifier?: string;
  frame?: SpikeRect;
  enabled?: boolean;
  selected?: boolean;
  focused?: boolean;
}>;

export type RawAcquisition = Readonly<{
  targetId: string;
  targetGeneration: string | null;
  nodes: readonly RawAcquiredNode[];
  viewport: IosViewportEvidence;
  truncated: boolean;
  residue: readonly IosAcquisitionResidue[];
}>;

export type ResourceLimits = Readonly<{
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxNodes: number;
  maxTraversalDepth: number;
  maxCpuMs: number;
  maxMemoryBytes: number;
  maxDurationMs: number;
}>;

export type ResourceMetrics = Readonly<{
  requestBytes: number;
  responseBytes: number;
  nodeCount: number;
  maxTraversalDepth: number;
  cpuMs: number | null;
  memoryBytes: number | null;
  durationMs: number;
}>;

export type SpikeRequest = Readonly<{
  version: 1;
  id: string;
  candidate: CandidateId;
  simulatorUdid: string;
  state: LocalState;
  screen: ScreenId | 'unprepared-surface';
  appBundleId: string;
  targetWindowName?: string;
  targetProcessId?: number;
  expectedTargetGeneration?: string;
  limits: ResourceLimits;
}>;

export type SpikeResponse = Readonly<{
  version: 1;
  id: string;
  candidate: CandidateId;
  ok: boolean;
  acquisition?: RawAcquisition;
  failure?: SpikeFailure;
  metrics: ResourceMetrics;
}>;

export type PresentationMeasurement = Readonly<{
  ok: boolean;
  payloadBytes: number;
  nodeCount: number;
  durationMs: number;
  cpuMs: number | null;
  memoryBytes: number | null;
}>;

export type SpikeSample = Readonly<{
  index: number;
  candidate: CandidateId;
  state: LocalState;
  screen: ScreenId;
  startedAt: string;
  finishedAt: string;
  operation: 'acquisition' | 'presentation';
  wallClockMs: number;
  preparationMs?: number;
  firstLookMs?: number;
  firstTree: 'readable' | 'empty' | 'unreadable' | 'not-observed';
  ok: boolean;
  stderr?: string;
  acquisition?: RawAcquisition;
  metrics?: ResourceMetrics;
  presentation?: PresentationMeasurement;
  failure?: SpikeFailure;
}>;

export type ProtocolProbeLog = Readonly<{
  candidate: Exclude<CandidateId, 'xctest-control'>;
  id: string;
  stderr: string;
}>;

export type SpikeCell = Readonly<{
  candidate: CandidateId;
  state: LocalState;
  screen: ScreenId;
  sampleMinimum: number;
  acquisitionSamples: readonly SpikeSample[];
  presentationSamples: readonly SpikeSample[];
}>;

export type Toolchain = Readonly<{
  node: string;
  pnpm: string;
  xcode: string;
  simctl: string;
  os: string;
  arch: string;
  swift: string;
}>;

export type Target = Readonly<{
  udid: string;
  name: string;
  runtime: string;
}>;

export type PlistKeyChange = Readonly<{
  key: string;
  before?: unknown;
  after?: unknown;
}>;

export type PlistDiff = Readonly<{
  path: string;
  existedBefore: boolean;
  beforeSha256: string | null;
  afterSha256: string | null;
  changes: readonly PlistKeyChange[];
}>;

export type PreferenceEvidence = Readonly<{
  applied: boolean;
  restored: boolean;
  fixtureLaunchCompatible: boolean | null;
  simulatorStateBefore: string;
  diffs: readonly PlistDiff[];
}>;

export type LifecycleEvidence = Readonly<{
  source: 'framed-protocol-fixture';
  crash: Readonly<{ failure: SpikeFailureKind; recovered: boolean }>;
  timeout: Readonly<{ failure: SpikeFailureKind; recovered: boolean }>;
  cancellation: Readonly<{ failure: SpikeFailureKind; recovered: boolean }>;
  staleGeneration: Readonly<{ failure: SpikeFailureKind; recovered: boolean }>;
}>;

export type SpikeReport = Readonly<{
  schemaVersion: typeof SPIKE_SCHEMA_VERSION;
  issue: typeof SPIKE_ISSUE;
  parent: typeof SPIKE_PARENT;
  prerequisites: readonly string[];
  generatedAt: string;
  revision: Readonly<{ commit: string; branch: string; dirty: boolean }>;
  toolchain: Toolchain;
  target: Target;
  limits: ResourceLimits;
  status: 'completed' | 'stopped';
  corpusCoverage: 'full' | 'decisive-early-stop';
  candidates: readonly CandidateId[];
  config: Readonly<{
    states: readonly LocalState[];
    screens: readonly ScreenId[];
    requestedSamples: number;
  }>;
  protocolProbes: readonly SpikeResponse[];
  protocolProbeLogs: readonly ProtocolProbeLog[];
  preferenceEvidence: PreferenceEvidence;
  lifecycle: LifecycleEvidence;
  positiveControl: DeepButtonEvidence;
  cells: readonly SpikeCell[];
  decision: 'GO' | 'NO-GO';
  decisionReasons: readonly string[];
  nextInterface: string;
  stop?: Readonly<{
    category: 'infrastructure' | 'configuration';
    message: string;
    command?: string;
  }>;
}>;
