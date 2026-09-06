import type { ExecutionPlan } from './execution-plan.ts';
import type { GestureExecutionProfile } from '@agent-device/contracts/gesture-plan-types';
import type { PreresolvedInteractionTarget } from '@agent-device/contracts/interaction';
import type { DeviceLease } from '@agent-device/contracts/device';
import type {
  ReplayTargetGuardDenotation,
  TargetAnnotationV1,
} from '@agent-device/contracts/replay';
import type {
  DaemonArtifact as PublicDaemonArtifact,
  DaemonResponse as PublicDaemonResponse,
  DaemonResponseData as PublicDaemonResponseData,
} from '@agent-device/kernel/contracts';
import type { Rect } from '@agent-device/kernel/snapshot';
import type { DaemonWireRequest } from './daemon-request-wire.ts';
import type { SessionState } from './session-state.ts';

/**
 * The daemon's own request and response vocabulary: the wire shape from `daemon-request-wire.ts`
 * plus what only the daemon may see. A consumer that must stay free of live session state takes
 * `DaemonWireRequest` directly.
 */

export type DaemonArtifact = PublicDaemonArtifact;
export type DaemonResponseData = PublicDaemonResponseData;

export type DaemonOpenLifecycle = {
  beforeDispatch?: (session: SessionState) => Promise<DaemonResponse | undefined>;
};

type DaemonRequestInternal = {
  publicNetworkOnly?: true;
  openLifecycle?: DaemonOpenLifecycle;
  /**
   * The steps a batch still has ahead of this one. The open seam derives platform readiness
   * policy (runner demand) from it; the transport strips `internal`, so it never arrives from a
   * client.
   */
  executionPlan?: ExecutionPlan;
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
 * The server-side request: `DaemonWireRequest` plus what only the daemon may see. `internal`
 * carries `SessionState` callbacks and the admitted lease — which is why this type stays in the
 * daemon and why the wire half is declared separately. Zones below it that only need to classify
 * a command take `contracts/dispatched-command.ts` instead.
 */
export type DaemonRequest = DaemonWireRequest & {
  internal?: DaemonRequestInternal;
};

export type DaemonResponse = PublicDaemonResponse;
export type DaemonInvokeFn = (req: DaemonRequest) => Promise<DaemonResponse>;
