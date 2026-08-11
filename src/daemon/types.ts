import type { CommandFlags } from '@agent-device/contracts/command';
import type {
  GestureExecutionProfile,
  PreresolvedInteractionTarget,
} from '@agent-device/contracts/interaction';
import type { SessionAction, SessionSurface } from '@agent-device/contracts/session';
import type {
  LeaseBackend,
  DaemonArtifact as PublicDaemonArtifact,
  DaemonInstallSource as PublicDaemonInstallSource,
  DaemonRequestMeta as PublicDaemonRequestMeta,
  DaemonResponse as PublicDaemonResponse,
  DaemonResponseData as PublicDaemonResponseData,
  SessionRuntimeHints as PublicSessionRuntimeHints,
  DaemonRequest as WireRequest,
} from '@agent-device/kernel/contracts';
import type { DeviceInfo, PlatformSelector } from '@agent-device/kernel/device';
import type { Rect, SnapshotState, SnapshotCaptureBackend } from '@agent-device/kernel/snapshot';
import type { ExecBackgroundResult, ExecResult } from '../utils/exec.ts';
// Type-only import; erased at runtime. ref-frame.ts imports SessionState from
// here, so this back-edge must stay type-only to avoid a runtime cycle.
import type { SnapshotDiagnosticsState } from '@agent-device/contracts/capture';
import type { DeviceLease } from '@agent-device/contracts/device';
import type {
  AudioProbeSource,
  AppLogFailure,
  AppLogLiveHandle,
  DurableResourceEnvelope,
  ScreenRecordingLiveHandle,
} from '@agent-device/contracts/platform';
import type { AndroidNativePerfSession } from '../platforms/android/perf.ts';
import type { SessionScriptPublicationState } from './session-script-publication-state.ts';
import type {
  AppleXctracePerfCapture,
  AppleXctracePerfMode,
} from '../platforms/apple/core/perf-xctrace.ts';
import type {
  ReplayTargetGuardDenotation,
  TargetAnnotationV1,
} from '@agent-device/contracts/replay';
import type { RefFrameScope, RefFrameState } from './ref-frame.ts';
export type DaemonInstallSource = PublicDaemonInstallSource;
export type SessionRuntimeHints = PublicSessionRuntimeHints;
export type DaemonArtifact = PublicDaemonArtifact;
export type DaemonResponseData = PublicDaemonResponseData;

type DaemonRequestMeta = Omit<PublicDaemonRequestMeta, 'installSource' | 'lockPlatform'> & {
  installSource?: DaemonInstallSource;
  lockPlatform?: PlatformSelector;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
};

export type DaemonOpenLifecycle = {
  beforeDispatch?: (session: SessionState) => Promise<DaemonResponse | undefined>;
};

type DaemonRequestInternal = {
  openLifecycle?: DaemonOpenLifecycle;
  /**
   * Request-owned capability used when a fresh replay discovers its device
   * only inside the first open. The router retains that device's execution
   * lock before dispatch and releases it after the outer replay finalizes.
   */
  retainDeviceExecutionLock?: (deviceId: string) => Promise<void>;
  admittedLease?: DeviceLease;
  /**
   * Daemon-composed hierarchy capture used as operational evidence only.
   * It must not issue or replace client ref authority.
   */
  observationOnly?: true;
  /**
   * Implicit caller scope resolved before a nested dispatch replaces the
   * public session name with its effective scoped key.
   */
  resolvedSessionScope?: SessionState['sessionScope'];
  /** Terminate the targeted app without ending the owning daemon session. */
  closeAppOnly?: boolean;
  /** Provider-owned viewport already resolved while normalizing a nested gesture command. */
  gestureViewport?: Rect;
  /** Maestro-compat execution profile for timed coordinate swipes projected to `gesture pan`. */
  gestureExecutionProfile?: GestureExecutionProfile;
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
  /** Dual-endpoint counterpart of replayTargetGuard for target-authored drag. */
  replayTargetGuards?: {
    source: ReplayTargetGuardDenotation;
    destination: ReplayTargetGuardDenotation;
  };
  /**
   * ADR 0012 / #1349 deferred (post-resolution) identity verification: the
   * recorded `target-v1` landmark of an annotated selector `wait`, set ONLY
   * by the replay step loop. The wait dispatch threads it into the polling
   * loop as `recordedLandmark`; success then requires a selector match
   * carrying this identity, and a timeout with rejected candidates surfaces
   * the `WAIT_LANDMARK_MISMATCH_REASON` refusal the step loop converts into
   * an identity-mismatch divergence. Never used by the generic pre-dispatch
   * verification path — a wait's landmark may legitimately be absent when
   * the step starts.
   */
  replayLandmarkGuard?: TargetAnnotationV1;
  /**
   * ADR 0014 / #1654: the complete ref/node/tree target a mutating `find`
   * resolved against its fresh capture. Its presence both marks the ref as
   * find-owned (so admission/staleness policy is skipped) and supplies the node
   * adopted by the interaction leaf. One payload keeps those decisions from
   * becoming independently representable. The leaf still crosses the
   * side-effect seam and expires the frame.
   */
  findResolvedTarget?: PreresolvedInteractionTarget;
  /**
   * #1271 stage 2 (ADR 0012 decision 6 amendment): PROVENANCE — set by the
   * replay runtime (`invokeResolvedReplayAction`,
   * `session-replay-action-runtime.ts`) on every action it dispatches from a
   * replay plan, annotated or not. It marks the action as AUTHORED (it came
   * from the `.ad` under repair) rather than typed out-of-band by the agent
   * mid-repair.
   *
   * The repair-segment exclusion keys off its ABSENCE: an authored
   * `get`/`is`/`find`/`snapshot` step must survive into its own healed script
   * (silently dropping it would make the heal quietly stop asserting what the
   * original flow asserted), while an interactive diagnostic read used only to
   * LOCATE the repair target must not. Command class alone cannot tell those
   * apart — they are the same command — so provenance is the discriminator and
   * `--record` is only for deliberately inserting an interactive read.
   *
   * Trustworthy because `internal` is daemon-only: `toDaemonRequest`
   * (`server/http-server.ts`) never copies it off the wire, so no client can
   * spoof authored provenance. Same channel as `replayTargetGuard` above.
   */
  replayPlanStep?: boolean;
};

/**
 * The server-side request: the wire shape plus what only the daemon may see. `token` and `session`
 * are required by the time a request is dispatched, `flags` is narrowed to the `CommandFlags`
 * vocabulary the wire cannot enforce, and `internal` carries `SessionState` callbacks and the
 * admitted lease — which is why this type stays in the daemon. Zones below it that only need to
 * classify a command take `contracts/dispatched-command.ts` instead.
 */
export type DaemonRequest = Omit<WireRequest, 'token' | 'session' | 'flags' | 'meta'> & {
  token: string;
  session: string;
  flags?: CommandFlags;
  meta?: DaemonRequestMeta;
  internal?: DaemonRequestInternal;
};

export type DaemonResponse = PublicDaemonResponse;
export type DaemonInvokeFn = (req: DaemonRequest) => Promise<DaemonResponse>;

export type AndroidSnapshotFreshness = {
  action: string;
  markedAt: number;
  baselineCount: number;
  baselineSignatures?: string[];
  routeComparable: boolean;
};

/**
 * One node's contribution to an interaction-surface signature. Two comparisons
 * read this, and they need different things from it, which is why both `key`
 * and `identity` exist:
 *
 * - `key` answers "is this the same node in the same state", including volatile
 *   viewport-derived state and an occurrence index. Back-to-back captures use
 *   it to decide the surface went quiet.
 * - `identity` answers "is this the same element at all", and is present only
 *   for nodes that carry one (an identifier, label or value). Comparisons
 *   across a gesture use it, because a gesture is exactly what changes the
 *   volatile state `key` folds in.
 */
export type InteractionSurfaceEntry = {
  key: string;
  /**
   * Identity-only key: what the element IS, never where it currently sits or
   * whether it is presently hittable. Undefined for anonymous layout nodes,
   * which carry no identity and can therefore only be matched by ordinal
   * position — an aliasing trap, so they are excluded from cross-gesture
   * comparison entirely.
   */
  identity?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * False for structurally fixed elements (the viewport root, keyboard
   * chrome) whose rect is invariant regardless of any gesture — shared
   * evidence limited to these is not evidence at all. See
   * `classifyBaselineSurfaceEvidence` in interaction-outcome-policy.ts.
   */
  discriminating: boolean;
};

export type PostGestureStabilization = {
  action: string;
  /** The gesture's own positionals — wording input for the #1600 no-effect
   * warning; never re-dispatched. Always set by the only writer. */
  positionals: string[];
  markedAt: number;
  /**
   * Pre-gesture interaction-surface signature, captured from the session's
   * last-known snapshot before the gesture dispatched (no extra capture — see
   * `markPostGestureStabilization`). Populated only when
   * `requiresPostGestureBaselineDistrust` is true for the session's device
   * (Apple mobile only, #1542 defect 2): a post-gesture quiet-poll match that
   * still equals this baseline is a stale-but-internally-consistent AX read,
   * not proof the screen settled. Android's persistent helper clears its a11y
   * cache before every capture (#1254/#1259) and needs no baseline check.
   */
  baselineSignature?: InteractionSurfaceEntry[];
  /**
   * Snapshot backend that produced `baselineSignature`. Backends do not return
   * comparable views of one screen — on the same iOS screen private AX returns
   * the scrolled-away content the tree backend prunes — so a quiet capture from
   * a different backend can only be re-baselined against, never concluded from
   * (#1569).
   */
  baselineBackend?: SnapshotCaptureBackend;
};

export type PendingInteractionOutcome = {
  action: string;
  command: string;
  positionals: string[];
  flags?: CommandFlags;
  markedAt: number;
  attemptsRemaining: number;
  preSignature: InteractionSurfaceEntry[];
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
  /** Advisory host-global local-device claim owned by this session, if acquired. */
  deviceClaim?: {
    deviceKey: string;
    ownerToken: string;
    ownerPid: number;
    ownerStartTime: string | null;
  };
  device: DeviceInfo;
  createdAt: number;
  surface?: SessionSurface;
  appBundleId?: string;
  appName?: string;
  snapshot?: SnapshotState;
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
  /**
   * One-shot latch: the full "overly complex or slow accessibility tree" warning has been
   * rendered to this session's client for the app currently under the XCTest-channel
   * penalty. Penalty-deferred verdicts (`reasonCode: 'deferred'`) suppress the repeated
   * warning in `renderSnapshotQualityWarnings`, but internal captures (selector
   * resolution, settle observation, system-modal probes) can arm the runner-side penalty
   * without any user-facing render — when the latch is not held, the first public
   * deferred verdict re-renders the warning once. Managed only through
   * `src/daemon/snapshot-quality-latch.ts`: a genuine recovered render sets it, a healthy
   * public verdict clears it, and an app switch supersedes it.
   */
  recoveredSnapshotWarningLatch?: { appBundleId?: string };
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
  /**
   * The tagged script-publication aggregate (#1478 P4a): ordinary authoring (ADR 0016), the
   * ADR 0012 decision 6 repair transaction, and the shared output target with its per-target
   * force authorization, in one state machine. `undefined` means `NO_SCRIPT_PUBLICATION` —
   * mutate only through the daemon-private `ReplaySessionTransaction`/`SessionScriptPublication`
   * projections; ordinary readers use the read helpers in
   * `session-script-publication-state.ts`.
   */
  scriptPublication?: SessionScriptPublicationState;
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
   * stamped by the `ReplayCoordinator`'s `stampCorrectiveWatermark`
   * (`session-replay-coordinator.ts`, #1478 P4b). A MID-PLAN `caution`/`manual`
   * `failedIndex + 1` was already unconditionally
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
   * `undefined` for any hint outside the eligible set or a mid-plan
   * `caution`/`manual` divergence),
   * and cleared once a `--from` request observes the action count having
   * grown, so it never fires against an unrelated later request.
   */
  pendingRecordAndHeal?: { expectedFrom: number; actionsCountAtDivergence: number };
  actions: SessionAction[];
  /**
   * Neutral session-owned app-log resource. Durable coordinates are persisted
   * independently; the in-memory handle is never serialized or reconstructed
   * by SessionStore.
   */
  appLog?: {
    handle: AppLogLiveHandle;
    envelope: DurableResourceEnvelope<'app-log'>;
  };
  /** Native recording mechanics stay behind the adopted runtime handle. */
  screenRecording?: {
    handle: ScreenRecordingLiveHandle;
    envelope: DurableResourceEnvelope<'screen-recording'>;
  };
  appLogFailure?: AppLogFailure;
};

// The recorded-action SHAPE lives in contracts/ so replay/ and compat/ can read a script
// without depending on the server; re-exported here for the daemon's own consumers.
