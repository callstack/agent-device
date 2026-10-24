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
  /**
   * True when the session's app was opened with `--capture-network` (ADR 0037). It selects the
   * probe mode of the Apple dump, which reports the session's capture file instead of parsing the
   * app log. The file path itself is derived from `sessionId` by the host reader, so the input
   * carries no host path.
   */
  networkCapture?: boolean;
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
  /**
   * Traffic the injected iOS simulator capture probe recorded for the session (ADR 0037). Each
   * entry names the request URL the app itself asked for, so a request that reused a keep-alive
   * connection is not reduced to its connection's origin.
   */
  | Readonly<{
      source: 'probe';
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

/**
 * What the composition root read of the session's capture-probe file (ADR 0037). `path` is the file
 * this daemon owns; a probe that wrote nothing leaves `exists` false. `text` already carries the
 * operator's app-log redaction pass, so no consumer may treat it as raw app output.
 */
export type NetworkCaptureRead = NetworkAppLogRead &
  Readonly<{
    /** True when the probe stopped recording because the file reached its 32 MB cap (rule 6). */
    atSizeCap: boolean;
  }>;

export type NetworkRuntimeHost = Readonly<{
  commands: HostCommandRunner;
  appleTools: AppleToolHost;
  appLogs: Readonly<{
    readRecent(sessionId: string, maxScanLines: number): Promise<NetworkAppLogRead>;
    readProcessMarker(sessionId: string): Promise<AppLogProcessMarkerReadOutcome>;
  }>;
  /**
   * Reads the capture probe's file for a session. The path is derived by the composition root from
   * the session id, so platform code never names a host path of its own.
   */
  captureProbe: Readonly<{
    readRecent(sessionId: string, maxScanLines: number): Promise<NetworkCaptureRead>;
  }>;
  networkTransports: Readonly<{
    resolve(device: DeviceInfo): Promise<NetworkTransport>;
  }>;
}>;
