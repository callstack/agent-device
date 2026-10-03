import type { ActingPipelinePolicy } from '@agent-device/selectors/selector-pipeline-policy';
import type { PreresolvedInteractionTarget } from '@agent-device/contracts/interaction';
import type { ReplayTargetGuardDenotation } from '@agent-device/contracts/replay';

/**
 * ADR 0012 migration step 4, post-resolution guard: the LOCAL identity AND
 * the STRUCTURAL denotation (pre-order document index + same-parent sibling
 * ordinal) of the element replay's pre-action verification isolated. Set ONLY
 * by the replay step loop (via `DaemonRequest.internal.replayTargetGuard`) for
 * annotated verified actions — never on live interactive commands.
 *
 * Local identity alone is insufficient: ADR path 6 isolates ONE member among
 * several nodes that share the same `{id, role, label}` using sibling /
 * region-scoped viewportOrder. If verification isolates duplicate A but
 * dispatch's occlusion/visibility filtering selects duplicate B with the same
 * local identity, a local-identity-only guard would pass and tap the wrong
 * element. The structural denotation is the discriminator that catches that
 * split BEFORE the device action.
 */
export type ExpectedResolvedTarget = ReplayTargetGuardDenotation;

export type InteractionAction =
  | 'click'
  | 'press'
  | 'fill'
  | 'focus'
  | 'longPress'
  | 'hover'
  | 'scroll'
  | 'swipe'
  | 'pinch'
  | 'pan'
  | 'drag'
  | 'fling'
  | 'rotate'
  | 'transform';

export type ResolveInteractionTargetParams = {
  action: InteractionAction;
  requireInteractive: boolean;
  /**
   * The structural pipeline this action runs (#1656): occlusion, off-screen,
   * and hittable-ancestor promotion are the row's decisions. `promotedTarget`
   * for tap-shaped actions, `resolvedTarget` for the actions that must keep
   * the element they resolved.
   */
  pipeline: ActingPipelinePolicy;
  /**
   * How long a `promotedTarget` row may poll for a target that does not exist yet (never model- or
   * CLI-writable); `resolveSelectorInteractionTarget` caps it at the row's `maxTimeoutMs`. Anything
   * other than a positive integer, and every `resolvedTarget` row, takes one attempt.
   */
  readinessTimeoutMs?: number;
  /**
   * `--verify` (#1047): also capture the pre-action node set for a `point` target
   * so `changedFromBefore` evidence has a baseline. Ref/selector targets already
   * capture a snapshot to resolve the target, so this is a no-op cost for them —
   * their nodes are attached below regardless of this flag. For point targets,
   * which normally skip capture entirely, this opts into one extra capture, only
   * when the caller explicitly asked for verify evidence. Defaults to false.
   */
  captureEvidenceBaseline?: boolean;
  /** ADR 0012 step 4 post-resolution guard; see `ExpectedResolvedTarget`. */
  expectedResolvedTarget?: ExpectedResolvedTarget;
  /** Identifies one endpoint when a multi-target replay guard refuses. */
  replayTargetRole?: 'source' | 'destination';
  /**
   * #1654: the caller already resolved this `@ref` against its own capture, so
   * the ref branch adopts that node instead of looking the ref up again. Ref
   * targets only — a selector target has nothing pre-resolved to adopt.
   */
  preresolvedTarget?: PreresolvedInteractionTarget;
};
