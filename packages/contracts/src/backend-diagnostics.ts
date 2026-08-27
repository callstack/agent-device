import type { NetworkIncludeMode } from '@agent-device/kernel/contracts';

export type BackendDiagnosticsTimeWindow = {
  since?: string;
  until?: string;
};

export type BackendDiagnosticsPageOptions = BackendDiagnosticsTimeWindow & {
  cursor?: string;
  limit?: number;
};

export type BackendNetworkIncludeMode = NetworkIncludeMode;

export type BackendNetworkEntry = {
  timestamp?: string;
  method?: string;
  url?: string;
  status?: number;
  durationMs?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  metadata?: Record<string, unknown>;
};

export type BackendDumpNetworkOptions = BackendDiagnosticsPageOptions & {
  include?: BackendNetworkIncludeMode;
};

export type BackendDumpNetworkResult = {
  entries: readonly BackendNetworkEntry[];
  nextCursor?: string;
  timeWindow?: BackendDiagnosticsTimeWindow;
  backend?: string;
  redacted?: boolean;
  notes?: readonly string[];
};
