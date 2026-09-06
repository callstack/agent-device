import type { CommandFlags } from '@agent-device/contracts/command';
import type { SnapshotDiagnosticsState } from '@agent-device/contracts/capture';
import type { AppLogFailure, AppLogLiveHandle } from '@agent-device/contracts/app-log-runtime';
import type { AudioProbeLiveHandle } from '@agent-device/contracts/audio-probe-runtime';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import type {
  PerfNativeCaptureLiveHandle,
  PerfProfileHandoff,
} from '@agent-device/contracts/perf-runtime';
import type { ScreenRecordingLiveHandle } from '@agent-device/contracts/screen-recording-runtime';
import type { SessionAction, SessionSurface } from '@agent-device/contracts/session';
import type {
  LeaseBackend,
  SessionRuntimeHints as PublicSessionRuntimeHints,
} from '@agent-device/kernel/contracts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import type { SnapshotFreshnessWindow } from '../snapshot/snapshot-freshness/index.ts';
import type { RefFrame } from './ref-frame-slot.ts';
import type { SessionScriptPublicationState } from './session-script-publication-state.ts';

/**
 * The daemon's live session record and the shapes only it holds. Mutable state owned by the
 * session store and written through the modules R7 names in `scripts/layering/session-state.ts`;
 * `ref-frame.ts` owns the `refFrame` slot whose value is declared in `ref-frame-slot.ts`.
 *
 * Nothing here belongs on the wire. The request half of a dispatch lives in `daemon-request.ts`,
 * and its public-only shape in `daemon-request-wire.ts`.
 */

export type SessionRuntimeHints = PublicSessionRuntimeHints;

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
  baselineBackend?: string;
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

/**
 * A session together with the store key that addresses it: `address` is the exact string
 * `--session` must carry to reach `session`, and it is NOT always `session.name`. An implicitly
 * cwd-scoped session is named `default` and stored under `cwd:<hash>:default`, and `--session`
 * marks the session explicit, so `--session default` addresses a different session entirely
 * (#2031/#1394). Anything that turns a session into a path, a `--session` argument, or a `close`
 * target takes this pair rather than a bare record, so it cannot be handed a session whose address
 * was never resolved.
 */
export type SessionRef = {
  address: string;
  session: SessionState;
};

export type SessionScope =
  | { kind: 'cwd'; id: string }
  | { kind: 'tenant'; id: string }
  | { kind: 'named-local' }
  | { kind: 'global-default' };

export type SessionState = {
  name: string;
  sessionScope?: SessionScope;
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
  /** Enforced host-global local-device claim owned by this session, if acquired. */
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
   * ADR 0014 ref frame, owned by `ref-frame.ts` by construction: read it through that module's
   * accessors. Undefined is the pristine frame.
   */
  refFrame?: RefFrame;
  /** Last broad snapshot safe for Android route-freshness comparisons after interactive snapshots. */
  lastComparisonSafeSnapshot?: SnapshotState;
  androidSnapshotFreshness?: SnapshotFreshnessWindow;
  postGestureStabilization?: PostGestureStabilization;
  pendingInteractionOutcome?: PendingInteractionOutcome;
  snapshotDiagnostics?: SnapshotDiagnosticsState;
  trace?: {
    outPath: string;
    startedAt: number;
  };
  /** Native profiling mechanics stay behind one exact-owner durable handle. */
  perfCapture?: {
    handle: PerfNativeCaptureLiveHandle;
    envelope: DurableResourceEnvelope<'perf-capture'>;
  };
  /** Last stopped CPU-profile coordinates retained for report in the same live session. */
  lastPerfProfile?: PerfProfileHandoff;
  /** Native sampler mechanics stay behind the adopted runtime handle. */
  audioProbe?: {
    handle: AudioProbeLiveHandle;
    envelope: DurableResourceEnvelope<'audio-probe'>;
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
   * #1398 (ADR 0017 session-scoped echo protection amendment): explicit,
   * ephemeral `literal -> ${VAR}` placeholder map, populated only from the
   * SAME pair `fill --record-as` (ADR 0017) already computes as each
   * parameterized fill records. Consulted by `recordActionEntry` so a LATER
   * recorded action's own result/target evidence never re-serializes an
   * app-rendered echo of an already-authored literal. In-memory only for
   * this session's lifetime: never read by the script writer, the event
   * log, or diagnostics, and dropped with the session. Owned by
   * `src/daemon/session-action-recorder.ts`.
   */
  recordedFillLiterals?: Map<string, string>;
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
