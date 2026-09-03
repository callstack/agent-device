import type {
  IosAcquisitionResidue,
  IosViewportEvidence,
} from '@agent-device/contracts/ios-snapshot';
import type { LocalState, ScreenId } from '../ios-snapshot-benchmark/types.ts';

export type CandidateId = 'guest-simulator-framework-bridge' | 'xctest-control';

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

export type SpikeRect = Readonly<{ x: number; y: number; width: number; height: number }>;

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

export type SpikeSample = Readonly<{
  wallClockMs: number;
  preparationMs?: number;
  firstLookMs?: number;
  firstTree: 'readable' | 'empty' | 'unreadable' | 'not-observed';
  ok: boolean;
  acquisition?: RawAcquisition;
}>;

export type SpikeCell = Readonly<{
  candidate: CandidateId;
  state: LocalState;
  screen: ScreenId;
  acquisitionSamples: readonly SpikeSample[];
}>;

export type Revision = Readonly<{ commit: string; branch: string; dirty: boolean }>;
export type Toolchain = Readonly<{
  node: string;
  pnpm: string;
  xcode: string;
  simctl: string;
  os: string;
  arch: string;
}>;
export type Target = Readonly<{ udid: string; name: string; runtime: string }>;
export type GuestMechanismEvidence = Readonly<{
  implementation: 'idb';
  release: 'v1.5.2';
  companionArchive: 'idb-companion.macos-arm64.tar.gz';
  companionSha256: string;
  guestBinary: 'Resources/SimulatorFrameworkBridge';
  guestBinaryExpectedSha256?: string;
  guestBinarySha256: string;
  transport: string;
  traversal: string;
  client: 'node-direct-socket';
}>;

export type PreferenceEvidence = Readonly<{
  applied: boolean;
  restored: boolean;
  fixtureLaunchCompatible: boolean | null;
  simulatorStateBefore: string;
  diffs: readonly Readonly<{
    changes: readonly Readonly<{ key: string; before?: unknown; after?: unknown }>[];
  }>[];
}>;

export type SpikeReport = Readonly<{
  revision: Revision;
  guestMechanism: GuestMechanismEvidence;
  target: Target;
  toolchain: Toolchain;
  cells: readonly SpikeCell[];
  decisionReasons: readonly string[];
  preferenceEvidence?: PreferenceEvidence;
}>;
