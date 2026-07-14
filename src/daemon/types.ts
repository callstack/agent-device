import type {
  DaemonArtifact as PublicDaemonArtifact,
  DaemonRequest as PublicDaemonRequest,
  DaemonRequestMeta as PublicDaemonRequestMeta,
  DaemonResponse as PublicDaemonResponse,
  DaemonResponseData as PublicDaemonResponseData,
  DaemonInstallSource as PublicDaemonInstallSource,
  LeaseBackend,
  SessionRuntimeHints as PublicSessionRuntimeHints,
} from '../kernel/contracts.ts';
export type { DaemonLockPolicy } from '../kernel/contracts.ts';
import type { CommandFlags } from '../core/dispatch.ts';
import type { GestureReferenceFrame, ScrollDirection } from '../contracts/scroll-gesture.ts';
import type { LogBackend } from './network-log.ts';
import type { SessionSurface } from '../contracts/session-surface.ts';
import type { RecordingExportQuality } from '../core/recording-export-quality.ts';
import type { RecordingScope } from '../contracts/recording-scope.ts';
import type { DeviceInfo, Platform, PlatformSelector } from '../kernel/device.ts';
import type { ExecBackgroundResult, ExecResult } from '../utils/exec.ts';
import type { SnapshotState } from '../kernel/snapshot.ts';
// Type-only import; erased at runtime. ref-frame.ts imports SessionState from
// here, so this back-edge must stay type-only to avoid a runtime cycle.
import type { RefFrameScope, RefFrameState } from './ref-frame.ts';
import type { TargetAnnotationV1 } from '../replay/target-identity.ts';
import type { ReplayTargetGuardDenotation } from '../replay/target-identity-node.ts';
import type { AppLogFailure, AppLogState } from './app-log-process.ts';
import type { DeviceLease } from './lease-registry.ts';
import type { AndroidNativePerfSession } from '../platforms/android/perf.ts';
import type {
  AppleXctracePerfCapture,
  AppleXctracePerfMode,
} from '../platforms/apple/core/perf-xctrace.ts';
import type { AudioProbeSource } from '../audio-probe-result.ts';
import type { SnapshotDiagnosticsState } from '../snapshot-diagnostics.ts';
export type {
  ReplaySuiteAttemptFailure,
  ReplaySuiteResult,
  ReplaySuiteTestFailed,
  ReplaySuiteTestPassed,
  ReplaySuiteTestResult,
  ReplaySuiteTestSkipped,
  ReplaySuiteTestSkipReason,
} from '../contracts/replay.ts';

export type DaemonInstallSource = PublicDaemonInstallSource;
export type SessionRuntimeHints = PublicSessionRuntimeHints;
export type DaemonArtifact = PublicDaemonArtifact;
export type DaemonResponseData = PublicDaemonResponseData;

type DaemonRequestMeta = Omit<PublicDaemonRequestMeta, 'installSource' | 'lockPlatform'> & {
  installSource?: DaemonInstallSource;
  lockPlatform?: PlatformSelector;
  leaseBackend?: LeaseBackend;
};

export type DaemonOpenLifecycle = {
  beforeDispatch?: (session: SessionState) => Promise<DaemonResponse | undefined>;
};

type DaemonRequestInternal = {
  openLifecycle?: DaemonOpenLifecycle;
  admittedLease?: DeviceLease;
  /**
   * ADR 0012 step 4 post-resolution guard: the verified target member's
   * normalized local identity AND structural denotation (document order +
   * sibling ordinal), set ONLY by the replay step loop when dispatching an
   * annotated action whose pre-action verification passed. Interaction
   * handlers thread it into command options as `expectedResolvedTarget`;
   * dispatch's own resolution refuses (pre-action) when its winner differs in
   * local identity OR structural position — the latter distinguishes a
   * different same-identity duplicate.
   */
  replayTargetGuard?: ReplayTargetGuardDenotation;
  /**
   * ADR 0014: set when a mutating `find` re-enters the interaction leaf with the
   * ref it just resolved by locator against a fresh capture. That ref is find's
   * own diagnostic identity, not a client-supplied ref subject to frame
   * lifetime, so the leaf skips ref-frame admission (it still crosses the
   * side-effect seam and expires the frame).
   */
  findResolvedTarget?: boolean;
};

export type DaemonRequest = Omit<PublicDaemonRequest, 'token' | 'session' | 'flags' | 'meta'> & {
  token: string;
  session: string;
  flags?: CommandFlags;
  meta?: DaemonRequestMeta;
  internal?: DaemonRequestInternal;
};

export type DaemonResponse = PublicDaemonResponse;
export type DaemonInvokeFn = (req: DaemonRequest) => Promise<DaemonResponse>;

type RecordingTelemetryBase = {
  tMs: number;
  x: number;
  y: number;
  referenceWidth?: number;
  referenceHeight?: number;
};

type RecordingTelemetryTravel = RecordingTelemetryBase & {
  x2: number;
  y2: number;
  durationMs: number;
};

export type RecordingGestureEvent =
  | (RecordingTelemetryBase & {
      kind: 'tap' | 'longpress';
      durationMs?: number;
    })
  | (RecordingTelemetryTravel & {
      kind: 'swipe';
    })
  | (RecordingTelemetryTravel & {
      kind: 'scroll';
      contentDirection: ScrollDirection;
      amount?: number;
      pixels?: number;
    })
  | (RecordingTelemetryTravel & {
      kind: 'back-swipe';
      edge: 'left' | 'right';
    })
  | (RecordingTelemetryBase & {
      kind: 'pinch';
      scale: number;
      durationMs: number;
    });

export type AndroidSnapshotFreshness = {
  action: string;
  markedAt: number;
  baselineCount: number;
  baselineSignatures?: string[];
  routeComparable: boolean;
};

export type PostGestureStabilization = {
  action: string;
  markedAt: number;
};

export type PendingInteractionOutcome = {
  action: string;
  command: string;
  positionals: string[];
  flags?: CommandFlags;
  markedAt: number;
  attemptsRemaining: number;
  preSignature: Array<{
    key: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
};

type SessionRecordingBase = {
  outPath: string;
  clientOutPath?: string;
  telemetryPath?: string;
  warning?: string;
  overlayWarning?: string;
  startedAt: number;
  recordingScope?: RecordingScope;
  recordingBackend?: string;
  recordOnlySession?: boolean;
  activeSessionApp?: {
    bundleId: string;
    name?: string;
  };
  maxSize?: number;
  exportQuality?: RecordingExportQuality;
  showTouches: boolean;
  gestureEvents: RecordingGestureEvent[];
  touchReferenceFrame?: GestureReferenceFrame;
  gestureClockOriginAtMs?: number;
  gestureClockOriginUptimeMs?: number;
  runnerSessionId?: string;
  invalidatedReason?: string;
};

export type RecordingChunk = {
  index: number;
  path: string;
  remotePath: string;
};

type SessionRecordingProcessChild = Pick<ExecBackgroundResult['child'], 'kill' | 'pid'>;

export type SessionState = {
  name: string;
  sessionScope?: {
    kind: 'cwd';
    id: string;
  };
  lease?: {
    leaseId: string;
    tenantId: string;
    runId: string;
    leaseBackend?: LeaseBackend;
    leaseProvider?: string;
    deviceKey?: string;
    clientId?: string;
    expiresAt?: number;
  };
  device: DeviceInfo;
  createdAt: number;
  surface?: SessionSurface;
  appBundleId?: string;
  appName?: string;
  snapshot?: SnapshotState;
  /**
   * Honest-marker for stale client refs (#1076): true when the stored session
   * snapshot was replaced by a capture whose response did NOT hand the new refs
   * to the client (selector-resolution captures, wait/find polling captures,
   * verify-evidence captures, ...). Commands that consume `@ref` arguments while
   * this is true must surface staleness — refs are positional indexes into the
   * latest tree, so they may silently resolve to different elements. iOS
   * mutations reject before dispatch; read-only and non-iOS consumers attach a
   * warning. Cleared only where
   * the client demonstrably receives the new refs (snapshot responses, find
   * responses that return a ref). Set/cleared at the choke points documented in
   * `setSessionSnapshot` (src/daemon/session-snapshot.ts).
   */
  snapshotRefsStale?: boolean;
  /**
   * Monotonically increasing generation of the stored session snapshot (#1076
   * versioned refs). Incremented every time the stored tree is REPLACED — at
   * the `setSessionSnapshot` choke point and in the snapshot/diff command path
   * (`buildNextSnapshotSession`). Ref-issuing responses (snapshot command, find
   * ref outputs) report it once as the additive `refsGeneration` field;
   * consumers may pin refs as `@e12~s3` and get a precise staleness diagnostic
   * when the pinned generation no longer matches the stored tree. Plain number
   * with per-session lifetime — no persistence. The first bump of a lifetime
   * seeds at a random 6-digit base (`nextSnapshotGeneration`), so a pin from a
   * previous lifetime of a reopened same-named session collides only with
   * ~1e-6 probability instead of commonly: cross-lifetime protection is
   * probabilistic (seeded), NOT identity-based.
   */
  snapshotGeneration?: number;
  /** Source snapshot used to resolve repeated `snapshot -s @ref` after scoped output replaces refs. */
  snapshotScopeSource?: SnapshotState;
  /**
   * ADR 0014 ref-frame lifecycle state. Undefined is treated as `active`. A
   * device side effect transitions the frame to `expired` (wired at the
   * side-effect seam in a later migration step); an expired frame admits no ref
   * mutation. Managed only through `src/daemon/ref-frame.ts`.
   */
  refFrameState?: RefFrameState;
  /**
   * ADR 0014 issuance scope of the current ref frame. Undefined is treated as
   * `all` (a complete namespace). A bounded set names the ref bodies a partial
   * publication (`find`, settled diff, replay divergence) actually issued, which
   * are the only bodies a pinned mutation may target. Managed only through
   * `src/daemon/ref-frame.ts`.
   */
  refFrameScope?: RefFrameScope;
  /**
   * ADR 0014 immutable source tree of the current ref frame: the tree that
   * minted the frame's refs, retained so a ref resolves to the node the caller
   * was authorized against — never to a different element by positional
   * coincidence in a newer operational observation (`snapshot`). Shares the
   * capture object with `snapshot` at activation (no deep copy); an Android
   * freshness or other read-only capture advances `snapshot` WITHOUT touching
   * this, so the two intentionally diverge. Managed only through
   * `src/daemon/ref-frame.ts` and the partial-issuance writer. Undefined falls
   * back to `snapshot` (pre-frame sessions).
   */
  refFrameTree?: SnapshotState;
  /**
   * ADR 0014 ref-frame epoch, frozen at the generation the frame was issued at
   * (the `refsGeneration` the client received). A later read-only capture
   * advances `snapshotGeneration` (the observation counter) WITHOUT reissuing
   * refs, so admission and pin comparisons use this frame-pinned epoch — a
   * correct pin from the issuing frame is not falsely rejected because an
   * intervening read bumped the observation counter. Undefined falls back to
   * `snapshotGeneration`. Managed only through `src/daemon/ref-frame.ts` and the
   * partial-issuance writer.
   */
  refFrameGeneration?: number;
  /** Last broad snapshot safe for Android route-freshness comparisons after interactive snapshots. */
  lastComparisonSafeSnapshot?: SnapshotState;
  androidSnapshotFreshness?: AndroidSnapshotFreshness;
  postGestureStabilization?: PostGestureStabilization;
  pendingInteractionOutcome?: PendingInteractionOutcome;
  snapshotDiagnostics?: SnapshotDiagnosticsState;
  trace?: {
    outPath: string;
    startedAt: number;
  };
  applePerf?: {
    active?: AppleXctracePerfCapture;
    lastProfileTracePath?: string;
    lastProfileTemplate?: string;
    lastTracePath?: string;
    lastMode?: AppleXctracePerfMode;
  };
  nativePerf?: {
    android?: AndroidNativePerfSession;
  };
  audioProbe?: {
    platform: 'host-system-audio';
    source: AudioProbeSource;
    backend: string;
    sourceCount: number;
    notes: string[];
    child: SessionRecordingProcessChild;
    wait: Promise<ExecResult>;
    statusPath: string;
    startedAt: number;
    durationMs: number;
    bucketMs: number;
  };
  /** Session was created by record start and should be released when recording stops. */
  recordOnlySession?: boolean;
  recordSession?: boolean;
  saveScriptPath?: string;
  /**
   * #1258: `--force`/`--overwrite` captured at the moment `--save-script` was
   * armed (`open --save-script --force`, `close --save-script --force`, or
   * `replay --save-script --force`'s first arm) — persisted here, like
   * `saveScriptPath`, so a LATER write that does not repeat the flag (a bare
   * `close` finishing a session opened with `open --save-script --force`, a
   * `--from` continuation leg, or an unattended auto-commit teardown with no
   * live request at all) still honors the overwrite the caller opted into up
   * front. The effective decision at any write site is `req.flags?.force ||
   * session.saveScriptForce`.
   *
   * Force is PER-TARGET, not a session-wide standing grant: it stays set while
   * the target is unchanged, but re-arming a DIFFERENT `--save-script=<other>`
   * without a live `--force` CLEARS it (`applySaveScriptRetarget`), so a later
   * retarget can never silently overwrite a file the caller never opted into.
   * A live `--force` on the retarget re-grants it for the new target.
   */
  saveScriptForce?: boolean;
  /**
   * ADR 0012 decision 6, R6: `session.actions.length` at the `replay
   * --save-script` invocation that armed this session — the repair-run
   * boundary. The healed `.ad` serializes only `session.actions` from this
   * index onward, so a reused session's earlier, unrelated actions never
   * leak into the healed script.
   */
  saveScriptBoundary?: number;
  /**
   * ADR 0012 decision 6: set when `saveScriptPath` was DEFAULTED to the
   * `<original-stem>.healed.ad` sibling (no explicit `--save-script=<out>`).
   * Bookkeeping only — it does not gate the writer's refuse-on-exist
   * decision, which is uniform regardless of this flag (see
   * `publishHealedScriptAtomically`): a second repair against the same
   * original is refused at the default healed sibling exactly like an
   * explicit `--save-script=<path>` or an ordinary recording's target would
   * be, never destroying an unreviewed prior `.healed.ad` diff.
   */
  saveScriptDefaultedHealedPath?: boolean;
  /**
   * ADR 0012 decision 6, R7 + commit semantics (C2): the repair TRANSACTION
   * completion flag. `true` iff the last repair-armed replay run reached its
   * final EXECUTABLE step with no outstanding divergence (the terminal source
   * `close` is excluded — C4). Commit is gated on this, NOT merely on a
   * `close`: `SessionScriptWriter.write` publishes a repair-armed session's
   * healed `.ad` only when complete, so a `close`/`close --save-script`
   * issued after a divergence but before the plan finishes discards a prefix
   * instead of committing it. States: ARMED (`saveScriptBoundary` set,
   * complete unset) -> COMPLETE (this true) -> COMMITTED (`saveScriptCommitted`).
   */
  saveScriptComplete?: boolean;
  /**
   * ADR 0012 decision 6 (C2): set by the writer after a repair-armed session's
   * healed `.ad` is atomically published. Makes re-publish idempotent (a second
   * `writeSessionLog` no-ops) and lets teardown distinguish a COMMITTED session
   * (nothing to tombstone) from an aborted/reaped one.
   */
  saveScriptCommitted?: boolean;
  /**
   * ADR 0012 decision 6 (BLOCKER 3, second follow-up): set the moment a
   * repair-armed `close`'s targeted platform close returns SUCCESS, cleared
   * once the transaction commits/tears down (never lingers past a single
   * close attempt's outcome). If the subsequent commit then FAILS (no-clobber
   * refusal, a bare-`@ref` failure, or an fs error) the session is retained
   * for retry — a later `close`/`close --save-script=<other>` on the SAME
   * session must consume this flag and skip re-dispatching the platform
   * close rather than invoking a (possibly non-idempotent) backend a second
   * time against an already-closed target.
   *
   * BLOCKER 3 (third follow-up): this flag alone is session-wide, not bound
   * to WHICH close request succeeded — see `repairPlatformCloseIdentity`,
   * which must ALSO match the retry's own request identity before a retry is
   * allowed to skip the platform close.
   */
  repairPlatformCloseSucceeded?: boolean;
  /**
   * ADR 0012 decision 6 (BLOCKER 3, third follow-up): the identity
   * (`repairPlatformCloseIdentity` in session-close.ts — currently just the
   * request's target/positionals, the only thing that changes what the
   * platform close actually dispatches) of the close request whose platform
   * close last succeeded. A retry only gets to skip re-dispatching the
   * platform close when BOTH `repairPlatformCloseSucceeded` is true AND this
   * matches the retry's own identity — an untargeted close that performed NO
   * platform operation (so `repairPlatformCloseSucceeded` is trivially true)
   * must never let a later targeted (or differently-targeted) retry skip the
   * platform close it never actually ran.
   */
  repairPlatformCloseIdentity?: string;
  /**
   * ADR 0012 decision 6, R7 (C5a): the original replay input path of an armed
   * repair, stashed so an idle-reap tombstone can hand the agent an actionable
   * `replay <path> --save-script` re-run command instead of a bare
   * SESSION_NOT_FOUND.
   */
  repairSourcePath?: string;
  /**
   * ADR 0012 decision 6, R2/R3, extended per #1262: set whenever a
   * `record-and-heal` divergence's `resume` reports `allowed: true` — its
   * `from` (the failed step's index + 1) assumes the agent performs the
   * diverged step manually before continuing, and nothing else enforces
   * that. Position-independent for `record-and-heal` (mid-plan or the
   * plan's last step).
   *
   * Also set for `caution`/`manual`, whose OWN `resume.from` stays at the
   * failed step's index unchanged (never made illegal) — but ONLY when the
   * diverged step is the plan's LAST one: those hints have a legitimate
   * record-and-heal-SHAPED alternate repair targeting `failedIndex + 1`,
   * stamped when that target is independently preflight-safe
   * (`stampPendingRecordAndHealWatermark`, `session-replay-resume.ts`). A
   * MID-PLAN `caution`/`manual` `failedIndex + 1` was already unconditionally
   * legal (in range) and un-gated before #1262 — these hints never mandate a
   * corrective action the way `record-and-heal` does, so an agent may
   * legitimately skip the diverged step without repairing it — and stays
   * un-gated: this field is never set for a mid-plan `caution`/`manual`
   * divergence.
   *
   * A later `--from` request that matches `expectedFrom` while
   * `session.actions.length` is still exactly `actionsCountAtDivergence` (no
   * new action recorded since) is rejected — proof the corrective press
   * never happened, so the resume would silently skip the unrepaired step
   * instead of healing it. Overwritten by the next divergence (cleared to
   * `undefined` for any hint outside the eligible set, a mid-plan
   * `caution`/`manual` divergence, or a last-step `caution`/`manual`
   * divergence whose `failedIndex + 1` target is not itself preflight-safe),
   * and cleared once a `--from` request observes the action count having
   * grown, so it never fires against an unrelated later request.
   */
  pendingRecordAndHeal?: { expectedFrom: number; actionsCountAtDivergence: number };
  actions: SessionAction[];
  recording?:
    | (SessionRecordingBase & {
        platform: 'ios';
        child: SessionRecordingProcessChild;
        wait: Promise<ExecResult>;
        recorderPid?: number;
        remotePath?: string;
      })
    | (SessionRecordingBase & {
        platform: 'android';
        recordingId?: string;
        remotePath: string;
        remotePid: string;
        remoteStartedAt?: number;
        chunks?: RecordingChunk[];
        rotationTimer?: NodeJS.Timeout;
        rotationPromise?: Promise<void>;
        rotationFailedReason?: string;
        stopping?: boolean;
      })
    | (SessionRecordingBase & {
        platform: 'ios-device-runner';
        remotePath: string;
        runnerStartedAtUptimeMs?: number;
        targetAppReadyUptimeMs?: number;
      })
    | (SessionRecordingBase & {
        platform: 'macos-runner';
        remotePath?: string;
      })
    | (SessionRecordingBase & {
        platform: 'web';
      });
  /** Session-scoped app log stream; logs written to outPath for agent to grep */
  appLog?: {
    platform: Platform;
    backend: LogBackend;
    outPath: string;
    startedAt: number;
    getState: () => AppLogState;
    stop: () => Promise<void>;
    wait: Promise<ExecResult>;
  };
  appLogFailure?: AppLogFailure;
};

/**
 * Per-nested-action source provenance for control-flow wrappers, parallel to
 * `actions`; `undefined` at an index means "the wrapping control action's own
 * file". The runtime block invoker reads it so a failure inside a wrapped
 * `runFlow` include reports the include's file+line, not the wrapper's.
 */
export type ReplayControlActionSource = { path: string; line: number };

export type SessionReplayControl =
  | {
      kind: 'maestroRunFlowWhen';
      mode: 'visible' | 'notVisible';
      selector: string;
      actions: SessionAction[];
      actionSources?: (ReplayControlActionSource | undefined)[];
    }
  | {
      kind: 'retry';
      maxRetries: number;
      actions: SessionAction[];
      actionSources?: (ReplayControlActionSource | undefined)[];
    };

export type SessionAction = {
  ts: number;
  command: string;
  positionals: string[];
  runtime?: SessionRuntimeHints;
  replayControl?: SessionReplayControl;
  flags: Partial<CommandFlags> & {
    snapshotInteractiveOnly?: boolean;
    snapshotDepth?: number;
    snapshotScope?: string;
    snapshotRaw?: boolean;
    launchArgs?: string[];
    saveScript?: boolean | string;
    noRecord?: boolean;
  };
  result?: Record<string, unknown>;
  /**
   * ADR 0012 decision 3: parsed or record-time-computed `target-v1`
   * evidence, written as a comment immediately before this action's line.
   * Inert until migration step 4 adds enforcement.
   */
  targetEvidence?: TargetAnnotationV1;
};
