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
  /** Daemon state dir (parent of `sessions/`), so an in-app capture can find this session's Metro hints. */
  stateDir?: string;
  maxEntries: number;
  include: NetworkIncludeMode;
  maxPayloadChars: number;
  maxScanLines: number;
}>;

/** Payload budget one `network dump` applies; the same bound pre-binds what a transport reads. */
export const NETWORK_MAX_PAYLOAD_CHARS = 2048;

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
  /**
   * The provider installed its capture during this call and its buffer was still empty, so this
   * call arms later traffic instead of reporting this one. A caller with a second capture source
   * answers the current window from that source and says so.
   */
  armed?: boolean;
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

/** Session facts a transport may need to reach one session's app-side traffic source. */
export type NetworkTransportScope = Readonly<{
  sessionId: string;
  /** Daemon state dir (parent of `sessions/`), where a session's Metro binding is recorded. */
  stateDir?: string;
  appBundleId?: string;
  /** Payload budget the dump will apply; a transport may pre-bound what it reads with it. */
  maxPayloadChars?: number;
  /**
   * Lazily composes the dev server's device name of exactly one device attached to this host. The
   * platform that owns the device inventory provides it; a transport calls it only inside a dump,
   * so a session whose transport declares none never pays for the probe (adb device properties or
   * `simctl list devices booted`). It answers undefined when the host cannot name one attached
   * device unambiguously; then the provider fails closed instead of guessing.
   */
  resolveMetroDeviceIdentity?: (signal: AbortSignal) => Promise<string | undefined>;
}>;

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
    resolve(device: DeviceInfo, scope?: NetworkTransportScope): Promise<NetworkTransport>;
  }>;
}>;
