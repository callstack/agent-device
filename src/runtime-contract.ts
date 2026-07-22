import type { AgentDeviceBackend } from './backend.ts';
import type { ArtifactAdapter } from './io.ts';
import type { SnapshotState } from './kernel/snapshot.ts';

export type CommandPolicy = {
  allowLocalInputPaths: boolean;
  allowLocalOutputPaths: boolean;
  maxImagePixels: number;
};

export type CommandSessionRecord = {
  name: string;
  appId?: string;
  appBundleId?: string;
  appName?: string;
  backendSessionId?: string;
  snapshot?: SnapshotState;
  /**
   * ADR 0014 authorized ref-frame source tree. When present it is the tree a
   * ref (`@eN`) resolves against for identity, so a newer operational
   * observation in `snapshot` (e.g. an Android freshness capture) cannot
   * retarget an already-authorized ref by positional coincidence. Absent for
   * pre-frame sessions and non-daemon runtimes, which resolve against `snapshot`.
   */
  refFrameSnapshot?: SnapshotState;
  metadata?: Record<string, unknown>;
};

// Runtime commands can read and then write the same session. CommandSessionStore
// implementations that are shared across concurrent callers should serialize
// per-session updates, or route commands through a transport that already does.
export type CommandSessionStore = {
  get(name: string): CommandSessionRecord | undefined | Promise<CommandSessionRecord | undefined>;
  set(record: CommandSessionRecord): void | Promise<void>;
  delete?(name: string): void | Promise<void>;
  list?(): readonly CommandSessionRecord[] | Promise<readonly CommandSessionRecord[]>;
};

export type CommandContext = {
  session?: string;
  requestId?: string;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
};

export type DiagnosticsSink = {
  emit(event: {
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    data?: unknown;
  }): void;
};

export type CommandClock = {
  now(): number;
  sleep(ms: number): Promise<void>;
};

export type AgentDeviceRuntime = {
  backend: AgentDeviceBackend;
  artifacts: ArtifactAdapter;
  sessions: CommandSessionStore;
  policy: CommandPolicy;
  diagnostics?: DiagnosticsSink;
  clock?: CommandClock;
  signal?: AbortSignal;
};

export type AgentDeviceRuntimeConfig = {
  backend: AgentDeviceBackend;
  artifacts: ArtifactAdapter;
  sessions?: CommandSessionStore;
  policy?: CommandPolicy;
  diagnostics?: DiagnosticsSink;
  clock?: CommandClock;
  signal?: AbortSignal;
};
