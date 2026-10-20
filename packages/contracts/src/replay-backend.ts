import type { DaemonError } from '@agent-device/kernel/errors';
import type { DaemonResponse, SessionRuntimeHints } from '@agent-device/kernel/contracts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { EnvMap, HostEnvironment } from '@agent-device/kernel/source-value';
import type { SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import type { CommandFlags } from './command-flags.ts';
import type { DaemonWireRequest } from './daemon-wire-request.ts';
import type {
  ReplayDivergenceResume,
  ReplayDivergenceSuggestionBasis,
} from './replay-divergence.ts';
import type {
  ReplayDispatchOptions,
  ReplayObservationAuthorityBinder,
  ReplayScriptSourceBundle,
} from './replay.ts';
import type { SessionAction } from './session-action.ts';
import type {
  SnapshotDiagnosticsState,
  SnapshotDiagnosticsSummary,
} from './snapshot-diagnostics.ts';

/**
 * The replay backend plugin contract (#3377): what a non-native replay engine implements
 * (`ReplayBackendPlugin`) and the host services the daemon lends it (`ReplayBackendHost`).
 *
 * The replay port owns the registry and builds the host; an engine package owns its plugin and
 * reaches process state, session policy, and daemon dispatch only through `host` and the command
 * it is handed. Everything here is type-only, so an engine can depend on this module without
 * evaluating any host code.
 */

/**
 * The slice of the daemon's live session record replay reads. The daemon passes its full
 * `SessionState`; replay never names the record itself, so the port depends on these fields and
 * nothing else the daemon keeps on a session.
 */
export type ReplaySessionState = Readonly<{
  name: string;
  device: DeviceInfo;
  appBundleId?: string;
  actions: SessionAction[];
  trace?: Readonly<{ outPath: string }>;
  /** Read for presence only: an active recording means replay video must not start another. */
  screenRecording?: object;
  snapshotDiagnostics?: Pick<SnapshotDiagnosticsState, 'samples'>;
}>;

export type ReplaySessionStore = Readonly<{
  get: () => ReplaySessionState | undefined;
  lookup: () => Readonly<{ address: string; session: ReplaySessionState }> | undefined;
  getRuntimeHints: () => SessionRuntimeHints | undefined;
  ensureSessionDir: () => string;
  /** Rejects the request when its device/platform selectors contradict the session's binding. */
  assertSelectorMatches: (flags: DaemonWireRequest['flags']) => void;
  /**
   * The runtime hints an `open` dispatched from this session would run with: the request's own,
   * the session's persisted ones, and the platform defaults the daemon owns.
   */
  resolveOpenRuntimeHints: (params: {
    request: DaemonWireRequest;
    device?: DeviceInfo;
    platform?: 'ios' | 'android';
  }) => SessionRuntimeHints | undefined;
}>;

/**
 * The replay side of the ref-publication owner: the operational capture it reads, a binder for
 * the daemon-side authority that records a capture and publishes exactly its own projection, and
 * the daemon's snapshot capture over this session. The session-store pair the authority is drawn
 * from stays in the daemon.
 */
export type ReplaySessionObservation = Readonly<{
  get: () => ReplaySessionState | undefined;
  bindAuthority: (signal?: AbortSignal) => ReturnType<ReplayObservationAuthorityBinder> &
    Readonly<{
      capture: (params: {
        flags: DaemonWireRequest['flags'];
        logPath: string;
      }) => Promise<{ snapshot: SnapshotState }>;
    }>;
}>;

export type ReplayDispatchRequest = DaemonWireRequest &
  Readonly<{ dispatch?: ReplayDispatchOptions }>;

export type ReplayInvoke = (request: ReplayDispatchRequest) => Promise<DaemonResponse>;

/**
 * The dispatch options a backend may ask the daemon to honor on a nested public command. A key
 * a backend adds without a counterpart in `ReplayDispatchOptions` fails to compile here.
 */
export type ReplayBackendDispatchOptions = Pick<
  ReplayDispatchOptions,
  | 'closeAppOnly'
  | 'killApp'
  | 'observationOnly'
  | 'gestureViewport'
  | 'gestureExecutionProfile'
  | 'settingsAppBundleId'
>;

/** One execution step a backend reports while an attempt runs. */
export type ReplayBackendStep = Readonly<{
  index: number;
  total: number;
  command?: string;
  value?: string;
}>;

export type ReplayBackendSession = Readonly<{
  /** The effective SessionStore key selected by request binding. */
  name: string;
  logPath: string;
  store: ReplaySessionStore;
  /** Bound observation reads and writes used by the ref-publication owner and divergence capture. */
  observationStore: ReplaySessionObservation;
}>;

/** One replay run as a backend sees it: the prepared request, its session, and the dispatch port. */
export type ReplayBackendCommand = Readonly<{
  request: DaemonWireRequest;
  /** The daemon's host facts (env and working directory); a backend never reads the process itself. */
  host: HostEnvironment;
  /**
   * True when the request reached the daemon over its public HTTP surface only: flow scripts are
   * then untrusted and `runScript` HTTP calls may not reach private addresses. Absent means a
   * local caller, which trusts its own scripts.
   */
  publicNetworkOnly?: true;
  /** Dispatch options every request this command issues carries, before its own. */
  dispatch?: ReplayDispatchOptions;
  session: ReplayBackendSession;
  invoke: ReplayInvoke;
  tracePath?: string;
  onStep?: (step: ReplayBackendStep) => void;
}>;

/** What a backend reports about one source before any run: the shared scheduling vocabulary. */
export type ReplaySourceInspection = Readonly<{
  /** The flow's authored title, when the format carries one. */
  title: string | undefined;
  /** A static app target the entry resolves to, for advisory device binding. */
  appTarget: string | undefined;
}>;

/** Reads one flow file, or reports that it is unavailable (#1802 readers). */
export type ReplayOptionalSourceReader = (resolvedPath: string) => string | undefined;

export type ReplayBackendExportWarning = Readonly<{
  line: number;
  action: string;
  message: string;
}>;

export type ReplayBackendExportResult = Readonly<{
  yaml: string;
  warnings: ReplayBackendExportWarning[];
}>;

/**
 * `TId` is the format grammar's backend vocabulary (`ReplayBackendId` in `@agent-device/ad-script`,
 * which sits above this package), so the registry's keys and the `--maestro` flag's accepted
 * values cannot drift apart.
 */
export type ReplayBackend<TId extends string = string> = Readonly<{
  id: TId;
  /** Expands the entry flow's include closure into a path-to-text map (best effort, #1802). */
  collectSourceFiles(params: {
    entryPath: string;
    entrySource: string;
    env?: Readonly<Record<string, string>>;
    readSource: ReplayOptionalSourceReader;
  }): Record<string, string>;
  /** Reads title/app-target metadata from one source, without running it. Throws on an invalid flow. */
  inspectSource(source: string, sourcePath: string): ReplaySourceInspection;
  /** Runs one replay through the backend's engine, owning no session or wire state. */
  runReplay(command: ReplayBackendCommand): Promise<DaemonResponse>;
  /** Converts a native `.ad` action list into the backend's own script format. */
  exportReplayScript(
    actions: SessionAction[],
    options: { actionLines?: number[]; metadata?: { env?: Record<string, string> } },
  ): ReplayBackendExportResult;
}>;

/** One failed step of a backend run, in the vocabulary the divergence report publishes. */
export type ReplayBackendActionFailure = Readonly<{
  error: DaemonError;
  req: DaemonWireRequest;
  sessionStore: ReplaySessionStore;
  observationStore: ReplaySessionObservation;
  logPath: string;
  replayPath: string;
  stepIndex: number;
  source: Readonly<{ path?: string; line: number }>;
  /** The authored step name, shown in the report and recorded as the failed action. */
  action: string;
  /** The step's display label: its name plus its rendered argument. */
  actionLabel: string;
  /** The `.ad`-shaped action the post-failure capture and suggestion ranking read. */
  captureAction: Readonly<{
    command: string;
    positionals: readonly string[];
    flags: SessionAction['flags'];
  }>;
  /** Control-flow steps fail without suggestions; the post-failure screen is still captured. */
  isControl: boolean;
  /** Values scrubbed from every published string. */
  redactions: readonly Readonly<{ name: string; value: string }>[];
  resume: ReplayDivergenceResume;
  artifactPaths: readonly string[];
  warnings: readonly string[];
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
  /** Candidate nodes the engine proposes for the failed step, before host ranking and bounding. */
  suggestNodes(
    snapshot: Readonly<{ createdAt: number; nodes: SnapshotNode[] }>,
  ): readonly Readonly<{ node: SnapshotNode; basis: ReplayDivergenceSuggestionBasis }>[];
}>;

/** The device-binding facts a backend resolves a target device from. */
export type ReplayBackendDeviceBinding = Readonly<{
  /** The flow's static app target, when it declares one. */
  appTarget: string | undefined;
  platform: CommandFlags['platform'] | undefined;
}>;

/**
 * The host services a backend plugin reaches. Everything holding process state or daemon
 * session policy is a member; stateless workspace packages stay direct imports of the plugin.
 */
export type ReplayBackendHost = Readonly<{
  /** Appends one record to the run's trace file, if any; failures are diagnostics, never thrown. */
  appendTraceEvent(tracePath: string | undefined, event: Record<string, unknown>): void;
  /** The `AD_*` variables every replay run is seeded with. */
  buildBuiltinVars(params: {
    req: DaemonWireRequest;
    sessionName: string;
    resolvedPath: string;
    /** The command's host working directory, which relative flow paths resolve against. */
    hostCwd: string;
  }): Record<string, string>;
  /** Reads one file out of the request's script source bundle; throws when it was not sent. */
  readScriptSourceFile(bundle: ReplayScriptSourceBundle, resolvedPath: string): string;
  scriptSourceRequiredMessage: string;
  /**
   * Selects the device a run binds when no session or explicit platform already names one. It
   * applies the Maestro device-binding rule (the flow's app target steers selection on iOS only),
   * the same rule `packages/daemon/src/server/replay-device-selection.ts` applies when it
   * pre-binds a device for the request.
   */
  resolveTargetDevice(
    flags: CommandFlags,
    binding: ReplayBackendDeviceBinding,
    env: EnvMap,
  ): Promise<DeviceInfo>;
  /** The abort signal of the in-flight daemon request. */
  requestSignal(requestId: string | undefined): AbortSignal | undefined;
  /** Builds the REPLAY_DIVERGENCE failure response: screen capture, ranking, bounding, resume. */
  buildActionFailureResponse(failure: ReplayBackendActionFailure): Promise<DaemonResponse>;
}>;

/**
 * Engine-free metadata, importable without evaluating the engine, so help stays light.
 */
export type ReplayBackendDeclaration<TId extends string = string> = Readonly<{
  id: TId;
  help: Readonly<{ summary: string; body: string }>;
}>;

export type ReplayBackendPlugin<TId extends string = string> = Readonly<{
  create(host: ReplayBackendHost): ReplayBackend<TId>;
}>;
