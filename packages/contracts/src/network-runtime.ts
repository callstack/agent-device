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

/**
 * Starts one session's live capture source. `network dump` never installs a source: it reads only
 * the source a prior `network start` selected (ADR 0037). A source is chosen at start and a dump
 * never switches silently.
 */
export type NetworkCaptureStartInput = Readonly<{
  sessionId: string;
  /** App the session has open, when one is open; a source reports `requiresRelaunch` from it. */
  appBundleId?: string;
  /** Extra domain selectors the source accepts, beyond its own default list. */
  hosts?: readonly string[];
}>;

/** Typed start refusals; a caller never matches on message text. */
export type NetworkCaptureStartFailureReason =
  | 'capture-already-started'
  | 'tunnel-in-use'
  | 'unsupported-device';

export type NetworkCaptureStartResult =
  | Readonly<{
      started: true;
      /** Name of the source now serving `network dump` for this session. */
      source: string;
      /** Domain selectors the source routes and inspects. */
      hosts: readonly string[];
      /**
       * True when the app was launched before capture started, so its already-open connections
       * are outside the capture window and the app must relaunch for full coverage.
       */
      requiresRelaunch: boolean;
      /** True when start keeps request and response bodies for `network dump --include body|all`. */
      capturingBodies: boolean;
    }>
  | Readonly<{ started: false; reason: NetworkCaptureStartFailureReason; message: string }>;

export type NetworkCaptureStopInput = Readonly<{
  sessionId: string;
}>;

export type NetworkCaptureStopResult = Readonly<{
  /** Whether a capture was running and is now stopped; a later dump reads the app log again. */
  stopped: boolean;
}>;

export type NetworkRuntimeOperations = Readonly<{
  networkDump(input: NetworkDumpInput): Promise<NetworkDumpResult>;
  /**
   * Live capture control. Owners without a capture source report both facts unavailable and bind
   * neither; `network dump` then keeps answering from the session app log.
   */
  networkCaptureStart(input: NetworkCaptureStartInput): Promise<NetworkCaptureStartResult>;
  networkCaptureStop(input: NetworkCaptureStopInput): Promise<NetworkCaptureStopResult>;
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
