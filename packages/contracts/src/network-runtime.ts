import type { NetworkIncludeMode } from '@agent-device/kernel/contracts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AppLogLiveState, AppLogProcessMarkerReadOutcome } from './app-log-runtime.ts';
import type { LogBackend } from './logs.ts';
import type { AppleToolHost, HostCommandRunner } from './platform-runtime-host.ts';
import type { RuntimeProviderMode } from './platform-runtime.ts';
import type { NetworkDump } from './network-traffic.ts';

export type NetworkAppLogSnapshot = Readonly<{
  state: AppLogLiveState;
  startedAt: number;
}>;

export type NetworkDumpInput = Readonly<{
  sessionId: string;
  appBundleId?: string;
  appLogSnapshot?: NetworkAppLogSnapshot;
  maxEntries: number;
  include: NetworkIncludeMode;
  maxPayloadChars: number;
  maxScanLines: number;
}>;

export type NetworkProviderEntry = Readonly<{
  timestamp?: string;
  method?: string;
  url?: string;
  status?: number;
  durationMs?: number;
  requestHeaders?: Readonly<Record<string, string>>;
  responseHeaders?: Readonly<Record<string, string>>;
  requestBody?: string;
  responseBody?: string;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type NetworkProviderDumpResult = Readonly<{
  backend: string;
  entries: readonly NetworkProviderEntry[];
  notes?: readonly string[];
}>;

export type NetworkDumpResult =
  | Readonly<{
      source: 'app-log';
      backend: LogBackend;
      dump: NetworkDump;
      notes: readonly string[];
    }>
  | (Readonly<{ source: 'provider' }> & NetworkProviderDumpResult);

export type NetworkRuntimeOperations = Readonly<{
  networkDump(input: NetworkDumpInput): Promise<NetworkDumpResult>;
}>;

export type NetworkProviderDump = (
  input: Readonly<{ maxEntries: number; include: NetworkIncludeMode }>,
  signal?: AbortSignal,
) => Promise<NetworkProviderDumpResult>;

export type NetworkTransport = Readonly<{
  mode: Extract<RuntimeProviderMode, 'local' | 'transport-composed'>;
  /** Absent when the selected narrow transport cannot provide network traffic. */
  dump?: NetworkProviderDump;
}>;

export type NetworkAppLogRead = Readonly<{
  path: string;
  exists: boolean;
  /** Exact line-bounded suffix selected with legacy split/slice semantics. */
  text: string;
  /** Number of leading split lines omitted from text; restores absolute source line numbers. */
  skippedLines: number;
}>;

export type NetworkRuntimeHost = Readonly<{
  commands: HostCommandRunner;
  appleTools: AppleToolHost;
  appLogs: Readonly<{
    readRecent(sessionId: string, maxScanLines: number): Promise<NetworkAppLogRead>;
    readProcessMarker(sessionId: string): Promise<AppLogProcessMarkerReadOutcome>;
  }>;
  networkTransports: Readonly<{
    resolve(device: DeviceInfo): Promise<NetworkTransport>;
  }>;
}>;
