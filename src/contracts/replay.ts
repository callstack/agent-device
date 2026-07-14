import type { DaemonError } from '../kernel/contracts.ts';
import type { SnapshotDiagnosticsSummary } from '../snapshot-diagnostics.ts';

export type ReplayCommandResult = {
  replayed: number;
  healed: number;
  session: string;
  artifactPaths: string[];
  warnings?: string[];
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
  message: string;
};

export type ReplaySuiteTestSkipReason = 'skipped-by-filter';

export type ReplaySuiteAttemptFailure = {
  attempt: number;
  message: string;
  durationMs?: number;
};

export type ReplaySuiteTestPassed = {
  file: string;
  title?: string;
  session: string;
  status: 'passed';
  durationMs: number;
  finalAttemptDurationMs?: number;
  attempts: number;
  artifactsDir?: string;
  replayed: number;
  healed: number;
  warnings?: string[];
  attemptFailures?: ReplaySuiteAttemptFailure[];
  shardIndex?: number;
  shardCount?: number;
  deviceId?: string;
  deviceName?: string;
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
};

export type ReplaySuiteTestFailed = {
  file: string;
  title?: string;
  session: string;
  status: 'failed';
  durationMs: number;
  attempts: number;
  artifactsDir?: string;
  error: DaemonError;
  shardIndex?: number;
  shardCount?: number;
  deviceId?: string;
  deviceName?: string;
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
};

export type ReplaySuiteTestSkipped = {
  file: string;
  title?: string;
  status: 'skipped';
  durationMs: 0;
  reason: ReplaySuiteTestSkipReason;
  message: string;
};

export type ReplaySuiteTestResult =
  | ReplaySuiteTestPassed
  | ReplaySuiteTestFailed
  | ReplaySuiteTestSkipped;

export type ReplaySuiteResult = {
  total: number;
  executed: number;
  passed: number;
  failed: number;
  skipped: number;
  notRun: number;
  durationMs: number;
  failures: ReplaySuiteTestFailed[];
  tests: ReplaySuiteTestResult[];
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
};
