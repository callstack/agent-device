import type { ReplaySuiteResult, ReplaySuiteTestFailed } from '@agent-device/contracts/replay';
import type { SnapshotDiagnosticsSummary } from '@agent-device/contracts/capture';
import type {
  ReplayTestProgressEvent,
  ReplayTestSuiteProgressEvent,
} from '@agent-device/contracts/progress';
import type { DeviceTarget, PlatformSelector } from '@agent-device/kernel/device';
import type {
  ReplayTestResolveShardTargets,
  ReplayTestShardContext,
  ReplayTestShardMode,
} from './session-test-sharding.ts';

/**
 * The device vocabulary a scheduler may name, sourced from the neutral kernel rather than
 * through `replay/script.ts` (#1478 P3b). These resolve to exactly what the `.ad` metadata
 * types resolved to — `Exclude<PlatformSelector, 'web'>` and `DeviceTarget` — so the manifest
 * shape is unchanged; only the import direction is. A format-neutral scheduler must not name
 * an engine module, and P5 relocates that engine into `packages/ad-replay` regardless.
 */
export type ReplayTestPlatform = Exclude<PlatformSelector, 'web'>;
export type ReplayTestTarget = DeviceTarget;

/**
 * One suite run, in vocabulary the scheduler owns (#1478 P3b).
 *
 * The façade takes this instead of a `DaemonRequest`. Every field is one the scheduler
 * actually reads; the adapter translates flags and meta into it and translates the result
 * back to a daemon response. Nothing here names a transport, a command, or a session store.
 *
 * `replayBackend` is absent by design: it selects an engine, and the adapter has already
 * applied it when building the source-discovery and shard-target capabilities.
 */
export type ReplayTestSuiteRequest = Readonly<{
  /** Paths and globs to expand. Never empty; the adapter rejects an empty invocation. */
  inputs: readonly string[];
  cwd?: string;
  /** Correlation id for attempt identity and the suite invocation id. */
  requestId?: string;
  /** Base session name that attempt sessions derive from. */
  sessionName: string;
  platformFilter?: PlatformSelector;
  artifactsDir?: string;
  failFast?: boolean;
  retries?: number;
  timeoutMs?: number;
  shard?: Readonly<{ mode: ReplayTestShardMode; count: number }>;
}>;

/**
 * What a suite run produces. Nothing throws across the façade: an invalid invocation or a
 * discovery failure resolves as `failed` with ADR 0010 error fields, which the adapter maps to
 * a daemon error response exactly as the in-handler `errorResponse` calls used to.
 */
export type ReplayTestSuiteOutcome =
  | Readonly<{ status: 'completed'; data: ReplaySuiteResult }>
  | Readonly<{ status: 'failed'; error: Readonly<{ code: string; message: string }> }>;

/**
 * Everything the scheduler may know about one discovered source (#1478 P3b).
 *
 * Inspecting a source needs an engine, so the host does it and the scheduler receives this.
 *
 * The fields are exactly the four the scheduler consumes (platform, target, retries,
 * timeoutMs) plus the title reporters display. Nothing else belongs here without a
 * demonstrated scheduler or reporter call site — no source format, app ID, environment,
 * Maestro tags/steps, digest, includes, config, or source path.
 */
export type ReplayTestManifest = Readonly<{
  title?: string;
  device: Readonly<{
    /**
     * How the source determines its platform. This is what replaced the scheduler's old
     * `resolveReplayFormat(...) === 'maestro'` check: it needs to know whether a missing
     * platform means "the caller supplies it" or "this source declared nothing", never which
     * engine produced it.
     *
     * - `declared` — the source names a platform, and a `--platform` filter compares against it;
     * - `caller-bound` — the format leaves platform to the caller (Maestro), so a filter runs it;
     * - `unspecified` — the source declared none, so a filter skips it as unmatched.
     */
    platform:
      | Readonly<{ kind: 'declared'; value: ReplayTestPlatform }>
      | Readonly<{ kind: 'caller-bound' }>
      | Readonly<{ kind: 'unspecified' }>;
    target?: ReplayTestTarget;
  }>;
  attemptDefaults?: Readonly<{
    timeoutMs?: number;
    retries?: number;
  }>;
}>;

/** One source the host found and inspected, ready for scheduler filtering policy. */
export type ReplayTestSource = Readonly<{
  path: string;
  manifest: ReplayTestManifest;
}>;

/**
 * Inspects each source the caller sent (#1478 P3b).
 *
 * Format routing and per-engine inspection are host work. #1802: so is expansion — the CALLER
 * expands its own inputs and ships each source's text, so nothing here takes inputs or a cwd.
 * The scheduler keeps discovery *policy* — platform filtering, run/skip classification, and
 * the "no replay tests matched" error — which is the part that is genuinely format-neutral.
 */
export type ReplayTestDiscoverSources = () => readonly ReplayTestSource[];

/**
 * One execution step an engine reports while an attempt runs (#1478 P3, finding 1).
 *
 * Step payloads originate below the attempt boundary, inside engine execution, and used to
 * reach the reporter through a request-global `AsyncLocalStorage` seeded per attempt. The
 * scheduler now hands each attempt a narrow sink instead, so step progress is an explicit
 * per-attempt port with two real adapters (native `.ad` and Maestro) rather than ambient
 * request state the scheduler cannot see.
 */
export type ReplayTestAttemptStep = {
  index: number;
  total: number;
  command?: string;
  value?: string;
};

export type ReplayTestAttemptStepSink = (step: ReplayTestAttemptStep) => void;

/**
 * ADR 0010 error fields exactly as the public suite result publishes them. This is the
 * neutral wire error, not `DaemonResponse`: the scheduler never sees a daemon response shape.
 */
export type ReplayTestAttemptError = ReplaySuiteTestFailed['error'];

export type ReplayTestAttemptPassed = {
  status: 'passed';
  replayed: number;
  healed: number;
  warnings: readonly string[];
  artifactPaths: readonly string[];
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
};

export type ReplayTestAttemptFailed = {
  status: 'failed';
  error: ReplayTestAttemptError;
  artifactPaths: readonly string[];
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
  /**
   * The host's verdict that this failure is environmental (device/runner/boot) rather than a
   * test failure, so retrying and continuing the suite cannot help. Classification needs
   * platform boot-diagnostic vocabulary, which the scheduler must not import, so the host
   * tags the outcome and the scheduler only reads the tag.
   */
  infrastructure: boolean;
};

/** Every expected attempt state resolves as a tagged outcome; nothing throws across the seam. */
export type ReplayTestAttemptOutcome = ReplayTestAttemptPassed | ReplayTestAttemptFailed;

export type ReplayTestRunReplayParams = {
  filePath: string;
  sessionName: string;
  platform?: ReplayTestPlatform;
  target?: ReplayTestTarget;
  requestId?: string;
  artifactsDir?: string;
  artifactPaths?: Set<string>;
  tracePath?: string;
  /**
   * Appends one event to this attempt's timing trace. The host records video lifecycle events
   * into the same trace the scheduler writes; handing it this closure keeps the trace format
   * private to the package instead of exporting a writer from the façade, and scopes the
   * authority to exactly this attempt's trace.
   */
  appendTimingEvent: (event: Record<string, unknown>) => void;
  shard?: ReplayTestShardContext;
  onStep?: ReplayTestAttemptStepSink;
};

export type ReplayTestRunReplay = (
  params: ReplayTestRunReplayParams,
) => Promise<ReplayTestAttemptOutcome>;

export type ReplayTestCleanupSession = (sessionName: string) => Promise<void>;

/**
 * Runs after the attempt settles and before cleanup. Returns a failure outcome when
 * finalization itself failed, or `undefined` when there was nothing to finalize.
 */
export type ReplayTestFinalizeAttempt = (params: {
  sessionName: string;
  artifactPaths: Set<string>;
  artifactsDir?: string;
  tracePath?: string;
  /** Same per-attempt trace appender the run receives; finalization records video events too. */
  appendTimingEvent: (event: Record<string, unknown>) => void;
}) => Promise<ReplayTestAttemptFailed | undefined>;

/**
 * Publishes one reporter-facing progress event (#1478 P3b).
 *
 * The host owns the request-global sink and injects this; the scheduler holds no ambient
 * authority to publish. Deliberately narrower than `RequestProgressSink`: the scheduler emits
 * suite and per-test events, never `CommandProgressEvent`, so it is not handed the ability to.
 */
export type ReplayTestEmitProgress = (
  event: ReplayTestSuiteProgressEvent | ReplayTestProgressEvent,
) => void;

/**
 * Whether the suite this scheduler is running has been canceled (#1478 P3b).
 *
 * The host binds this to its own request, so the scheduler asks a question it is entitled to
 * ask and learns nothing about how cancellation is tracked or keyed.
 */
export type ReplayTestIsCanceled = () => boolean;

/**
 * One operational diagnostic (#1478 P3b). `emitDiagnostic` reads a request-global
 * `AsyncLocalStorage` scope, so the scheduler receives the narrow publish capability instead
 * of the module. The level set is spelled out rather than imported so the vocabulary crossing
 * the seam stays neutral.
 */
export type ReplayTestEmitDiagnostic = (event: {
  level?: 'info' | 'warn' | 'error' | 'debug';
  phase: string;
  durationMs?: number;
  data?: Record<string, unknown>;
}) => void;

/**
 * Cancellation binding for one attempt (#1478 P3b).
 *
 * The brief gives the daemon adapter the job of mapping an engine-neutral attempt id to
 * daemon request identifiers and *binding cancellation*. The scheduler still owns timeout
 * policy — it decides when an attempt has run too long — so it needs to say "stop this
 * attempt" and "I am done with it", and nothing more. Registering the abort, relaying a
 * parent request's abort, and clearing the registry entry are all host concerns behind this.
 */
export type ReplayTestAttemptCancellation = {
  /** Signal the running attempt to stop. The scheduler calls this on timeout. */
  cancel: () => void;
  /** Release whatever the host bound for this attempt. Always called once it settles. */
  release: () => void;
};

export type ReplayTestBindAttemptCancellation = (params: {
  attemptId: string;
  parentAttemptId?: string;
}) => ReplayTestAttemptCancellation;

export type ReplayTestRuntimeDependencies = {
  runReplay: ReplayTestRunReplay;
  cleanupSession: ReplayTestCleanupSession;
  finalizeAttempt?: ReplayTestFinalizeAttempt;
  emitProgress: ReplayTestEmitProgress;
  isCanceled: ReplayTestIsCanceled;
  emitDiagnostic: ReplayTestEmitDiagnostic;
  bindAttemptCancellation: ReplayTestBindAttemptCancellation;
  discoverSources: ReplayTestDiscoverSources;
  resolveShardTargets: ReplayTestResolveShardTargets;
};

/**
 * What attempt execution needs. Discovery and shard resolution happen once, in the suite entry
 * point, so nothing below it is handed the ability to enumerate sources or bind devices.
 */
export type ReplayTestExecutionDependencies = Omit<
  ReplayTestRuntimeDependencies,
  'discoverSources' | 'resolveShardTargets'
>;

/** Neutral failure outcome helper; keeps timeout/unknown construction in one place. */
export function replayTestAttemptFailure(params: {
  error: ReplayTestAttemptError;
  artifactPaths?: readonly string[];
  infrastructure?: boolean;
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
}): ReplayTestAttemptFailed {
  return {
    status: 'failed',
    error: params.error,
    artifactPaths: params.artifactPaths ?? [],
    infrastructure: params.infrastructure ?? false,
    ...(params.snapshotDiagnostics ? { snapshotDiagnostics: params.snapshotDiagnostics } : {}),
  };
}
