// Shared data shapes for the perf suite and its night-over-night comparison.

export type Platform = 'ios' | 'android';

export type ExecMode = 'batch' | 'standalone' | 'sdk';

export type CliResult = {
  exitCode: number;
  wallClockMs: number; // measured by the harness around the child process
  stdout: string;
  stderr: string;
  json: unknown; // parsed --json payload (or undefined when not parseable)
  ok: boolean; // exit 0 AND (json.ok !== false)
};

export type Stat = {
  n: number;
  mean: number;
  stddev: number;
  cv: number;
  median: number;
  min: number;
  max: number;
  p95: number;
};

export type Timing = { count: number; totalMs: number };

/** Phase breakdown of one request, read from its daemon `--debug` request log. */
export type SampleProfile = {
  phases: Record<string, Timing>;
  runnerCommands: Record<string, Timing>;
  spawns: Record<string, Timing>;
  snapshotSources: Record<string, Timing & { failures: number }>;
  retries: number;
  stabilization: Timing;
  fallbacks: string[];
  // Daemon-side request time: from `request_start` to the last event of the request log.
  requestSpanMs?: number;
};

/** The settle outcome that a `--settle` response reports. */
export type SettleFacts = { waitedMs: number; captures?: number; settled?: boolean };

export type SnapshotFacts = {
  backend?: string;
  state?: string;
  reasonCode?: string;
  nodeCount?: number;
  maxDepth?: number;
  truncated?: boolean;
};

export type Sample = {
  round: number;
  wallClockMs: number;
  // Daemon request round trip: the client's `daemon_request` timer for CLI calls, the batch step
  // duration for batch calls, or the request-log span for SDK calls.
  daemonMs?: number;
  elementCount?: number;
  requestId?: string;
  snapshot?: SnapshotFacts;
  settle?: SettleFacts;
  profile?: SampleProfile;
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
};

export type MeasurementProfile = {
  runnerMs: number | null;
  spawnCount: number | null;
  spawnMs: number | null;
  snapshotSourceMs: number | null;
  stabilizationMs: number | null;
  settleWaitMs: number | null;
  retries: number;
  producers: Record<string, number>;
  backends: Record<string, number>;
  fallbacks: Record<string, number>;
  topPhases: { phase: string; medianMs: number }[];
};

export type Measurement = {
  id: string; // stable `<scenario>/<step>` comparison key
  scenario: string;
  label: string;
  command: string; // catalog command name
  args: string[];
  platform: Platform;
  execMode: ExecMode;
  samples: Sample[]; // measured rounds only (warmup rounds dropped)
  warmupDropped: number;
  wallClock: Stat | null;
  daemon: Stat | null;
  elementCount: Stat | null;
  profile: MeasurementProfile | null;
  failures: number;
  notes: string[];
};

export type RunMetadata = {
  commit: string;
  ref?: string;
  // Uncommitted changes in the checkout at the start of the run.
  dirty: boolean;
  runId?: string;
  runAttempt?: string;
  agentDeviceVersion: string;
  host: { os: string; arch: string; cpu: string; cores: number; memoryGb: number };
  xcode?: string;
  node: string;
  device: { name: string; udid?: string; serial?: string; runtime?: string };
  fixture?: { appId: string; appPath?: string };
};

export const PERF_SUMMARY_SCHEMA = 'agent-device-perf-summary/v1';

export type PerfSummary = {
  schema: typeof PERF_SUMMARY_SCHEMA;
  platform: Platform;
  startedAt: string;
  finishedAt: string;
  config: { rounds: number; warmup: number; scenarios: string[] };
  metadata: RunMetadata;
  coverage: { measured: string[]; excluded: { command: string; reason: string }[] };
  measurements: Measurement[];
};
