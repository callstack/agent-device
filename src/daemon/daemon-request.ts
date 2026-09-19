import type { ExecutionPlan } from './execution-plan.ts';
import type { PreresolvedInteractionTarget } from '@agent-device/contracts/interaction';
import type { DeviceLease } from '@agent-device/contracts/device';
import type { ReplayDispatchOptions } from '@agent-device/contracts/replay';
import type {
  DaemonArtifact as PublicDaemonArtifact,
  DaemonResponse as PublicDaemonResponse,
  DaemonResponseData as PublicDaemonResponseData,
} from '@agent-device/kernel/contracts';
import type { DaemonWireRequest } from '@agent-device/contracts/command';

/**
 * The daemon's own request and response vocabulary: the wire shape from `@agent-device/contracts/command` (`DaemonWireRequest`)
 * plus what only the daemon may see. A consumer that must stay free of live session state takes
 * `DaemonWireRequest` directly.
 */

export type DaemonArtifact = PublicDaemonArtifact;
export type DaemonResponseData = PublicDaemonResponseData;

/**
 * What only the daemon may see on a request: the replay dispatch options (declared once in
 * `@agent-device/contracts/replay`, so the port and the daemon cannot drift), plus the callbacks,
 * plan and lease the daemon composes for itself.
 */
type DaemonRequestInternal = ReplayDispatchOptions & {
  /**
   * What an `open` spent from its `--wait` budget while it waited for this device outside the
   * device execution lock. The refusal the open ends with has to say the budget was spent, and
   * only the daemon that spent it can know that; `internal` never crosses the transport, so no
   * client can claim a wait it did not perform.
   */
  openDeviceWait?: { waitedMs: number };
  publicNetworkOnly?: true;
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
   * ADR 0014 / #1654: the complete ref/node/tree target a mutating `find`
   * resolved against its fresh capture. Its presence both marks the ref as
   * find-owned (so admission/staleness policy is skipped) and supplies the node
   * adopted by the interaction leaf. One payload keeps those decisions from
   * becoming independently representable. The leaf still crosses the
   * side-effect seam and expires the frame.
   */
  findResolvedTarget?: PreresolvedInteractionTarget;
};

/**
 * The server-side request: `DaemonWireRequest` plus what only the daemon may see. `internal`
 * carries the admitted lease, the execution plan and request-owned callbacks — which is why this type stays in the
 * daemon and why the wire half is declared separately. Zones below it that only need to classify
 * a command take `contracts/dispatched-command.ts` instead.
 */
export type DaemonRequest = DaemonWireRequest & {
  internal?: DaemonRequestInternal;
};

export type DaemonResponse = PublicDaemonResponse;
export type DaemonInvokeFn = (req: DaemonRequest) => Promise<DaemonResponse>;
