export const BENCHMARK_SCHEMA_VERSION = 'ios-snapshot-convergence.v1' as const;
export const ISSUE_ID = '#2189';
export const PARENT_ISSUE_ID = '#2188';
export const DEEP_BUTTON_ISSUE_ID = '#1626';
export const APP_MOUNT_ISSUE_ID = '#1571';

export const WARM_SAMPLE_MINIMUM = 20;
export const COLD_SAMPLE_MINIMUM = 10;
export const PROXY_RTT_VALUES = [0, 20, 80] as const;

export type LocalState = 'cold-cold' | 'cold' | 'warm' | 'relaunch';
export type Transport = 'local' | 'proxy';
export type Execution = 'fresh-process-cli' | 'persistent-client';
export type ScreenId =
  | 'quiet'
  | 'list'
  | 'nested-scroll'
  | 'alert'
  | 'system-surface'
  | 'xctest-stress';

export type FailureCategory =
  | 'app-mount'
  | 'bridge'
  | 'runner'
  | 'timeout'
  | 'stale-generation'
  | 'packet-loss'
  | 'upstream'
  | 'other';

export type FirstTreeStatus = 'readable' | 'empty' | 'unreadable' | 'not-observed';

export type ScreenFixture = {
  id: ScreenId;
  label: string;
  app: string;
  launchUrl?: string;
  anchorText: string;
  postSetupAnchorText?: string;
  setupAction?: 'open-alert';
};

export type Failure = {
  category: FailureCategory;
  code?: string;
  reason?: string;
  message?: string;
};

export type RawSample = {
  index: number;
  startedAt: string;
  finishedAt: string;
  operation: 'open-foreground' | 'snapshot' | 'relaunch-foreground';
  wallClockMs: number;
  daemonDurationMs?: number;
  responseBytes?: number;
  nodeCount?: number;
  targetGeneration: number | null;
  firstTree: FirstTreeStatus;
  ok: boolean;
  outlier: boolean;
  failure?: Failure;
};

export type Summary = {
  n: number;
  min: number;
  median: number;
  p95: number;
  max: number;
  outlierCount: number;
  outlierRule: 'tukey-1.5-iqr';
};

export type Measurement = {
  transport: Transport;
  execution: Execution;
  state: LocalState;
  screen: ScreenId;
  sampleMinimum: number;
  operation: RawSample['operation'];
  samples: RawSample[];
  wallClockMs: Summary | null;
  daemonDurationMs: Summary | null;
  responseBytes: Summary | null;
  network?: ProxyNetwork;
  failures: number;
  failureCategories: Partial<Record<FailureCategory, number>>;
};

export type Toolchain = {
  node: string;
  pnpm: string;
  xcode: string;
  simctl: string;
  os: string;
  arch: string;
};

export type HostIdentity = {
  model: string;
  modelIdentifier: string;
  cpu: string;
  cpuCores: number;
};

export type GitRevision = {
  commit: string;
  branch: string;
  dirty: boolean;
};

export type Target = {
  platform: 'ios';
  kind: 'simulator';
  udid: string;
  name: string;
  runtime: string;
  appId: string;
  appPath?: string;
};

export type PackageSize = {
  status: 'measured' | 'not-run';
  revision: string;
  packed?: { tarballBytes: number; unpackedBytes: number };
  cleanInstalled?: { packageBytes: number; files: number };
  bundled?: { rawBytes: number; gzipBytes: number; files: number };
};

export type DeepButtonObservation = {
  depth: number;
  surfaceDigest: string;
  fullDigest: string;
  state: 'off' | 'on';
  surfaceNodeIds: string[];
  fullNodeIds: string[];
};

export type DeepButtonControl = {
  command: string;
  exitCode: number;
  assertion: string;
};

export type DeepButtonEvidence = {
  issue: typeof DEEP_BUTTON_ISSUE_ID;
  fixture: 'deep-button-v1';
  artifact: 'deep-button-fixture.v1.json';
  depth: number;
  changedDescendant: 'deep-button-state';
  invalidShallowRule: DeepButtonControl;
  safeFullRule: DeepButtonControl;
  before: DeepButtonObservation;
  after: DeepButtonObservation;
};

export type ProxyNetwork = {
  rttMs: (typeof PROXY_RTT_VALUES)[number];
  bandwidthKbps: number | null;
  packetLossPercent: number;
  seed: number;
};

export type BenchmarkStopReason = 'cell-state' | 'fixture-anchor' | 'derived-path';

export type BenchmarkStop = {
  category: 'infrastructure' | 'contention' | 'configuration';
  message: string;
  reason?: BenchmarkStopReason;
  command?: string;
};

export type BenchmarkResult = {
  schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  issue: typeof ISSUE_ID;
  parent: typeof PARENT_ISSUE_ID;
  references: { deepButton: typeof DEEP_BUTTON_ISSUE_ID; appMount: typeof APP_MOUNT_ISSUE_ID };
  runId: string;
  generatedAt: string;
  revision: GitRevision;
  toolchain: Toolchain;
  host: HostIdentity;
  target: Target;
  config: {
    warmSampleMinimum: number;
    coldSampleMinimum: number;
    requestedSamples: number;
    screens: ScreenId[];
    states: LocalState[];
  };
  status: 'completed' | 'stopped';
  measurements: Measurement[];
  proxyNetworks?: ProxyNetwork[];
  packageSize: PackageSize;
  deepButtonEvidence: DeepButtonEvidence;
  stop?: BenchmarkStop;
};
