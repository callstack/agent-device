import type { AgentDeviceBackend } from './backend.ts';
import type { ArtifactAdapter } from './artifact-adapter.ts';
import type { SurfaceScopedNodes } from './interaction.ts';
import type { SnapshotState } from '@agent-device/kernel/snapshot';

export type CommandPolicy = {
  allowLocalInputPaths: boolean;
  allowLocalOutputPaths: boolean;
  maxImagePixels: number;
};

/**
 * The tree a mutation resolved against, kept on the session with the instant that mutation
 * finished, so the next action can ask whether its own coordinates are still in play.
 *
 * A {@link SurfaceScopedNodes} rather than a whole capture: the gate compares node positions on one
 * surface, and the surface scoping is what keeps an iOS system-sheet tree from ever being compared
 * against app content (#2438).
 */
export type MovingTargetBaseline = Readonly<{
  /**
   * When the action finished, not when it began: the gate waits out what is LEFT of the window. The
   * daemon stamps it with `Date.now()`; the gate compares it against `now(runtime)`, so a runtime
   * that installs a clock of its own (a scenario pinning the window) states this value in that
   * clock's time too. Production installs none, so both sides read the wall clock.
   */
  finishedAt: number;
  /**
   * The tree the action acted through: its resolution's own observation, or the settled one its
   * `--settle` published as rest.
   */
  tree: SurfaceScopedNodes;
}>;

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
  /**
   * #3471: the tree the session's last resolving mutation acted through, with the instant that
   * mutation finished. The moving-target gate screens a freshly resolved rect against it to decide
   * whether the position is still owed a re-observation, which is why the pre-action tree — and not
   * just a timestamp — has to cross this boundary: the session's newest observation is by
   * construction the one that cannot prove a target held its position.
   */
  movingTargetBaseline?: MovingTargetBaseline;
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
