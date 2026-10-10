import type {
  BackendDiagnosticsTimeWindow,
  BackendLogEntry,
  BackendNetworkEntry,
  BackendPerfMetric,
} from '@agent-device/contracts/backend';

export type DiagnosticsLogsCommandResult = {
  kind: 'diagnosticsLogs';
  entries: readonly BackendLogEntry[];
  nextCursor?: string;
  timeWindow?: BackendDiagnosticsTimeWindow;
  backend?: string;
  redacted: boolean;
  notes?: readonly string[];
};

export type DiagnosticsNetworkCommandResult = {
  kind: 'diagnosticsNetwork';
  entries: readonly BackendNetworkEntry[];
  nextCursor?: string;
  timeWindow?: BackendDiagnosticsTimeWindow;
  backend?: string;
  redacted: boolean;
  notes?: readonly string[];
};

export type DiagnosticsPerfCommandResult = {
  kind: 'diagnosticsPerf';
  metrics: readonly BackendPerfMetric[];
  startedAt?: string;
  endedAt?: string;
  backend?: string;
  redacted: boolean;
  notes?: readonly string[];
};
