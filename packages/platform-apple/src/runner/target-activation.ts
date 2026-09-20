/**
 * The ONE decoder of the Apple runner's foreground-repair fact (#2682). The runner stamps the wire
 * shape on the response of the command that activated; this module is the only place it becomes an
 * `IosTargetActivation`. A reason the runner never stamps drops the fact rather than passing it
 * through: an undisclosed repair is a bug, a fabricated one is worse.
 */
import {
  isIosTargetActivationReason,
  type IosTargetActivation,
  type IosTargetActivationPriorState,
  type IosTargetActivationReason,
} from '@agent-device/kernel/snapshot';

/** Why a prior-state raw value could not be named, for the caller that owns the request log. */
export type UnmappedPriorStateDetail = Readonly<{
  /** Already checked against the declared reasons, so a log reader gets the name and not a string. */
  reason: IosTargetActivationReason;
  rawPriorState: number;
}>;

/** Wire key on the runner data payload of the command that activated (#2682). */
export const TARGET_ACTIVATION_WIRE_KEY = 'targetActivation';

/**
 * `XCApplicationState` raw value → declared state, declared by value and never by array position:
 * the enum ships in no public Xcode header this repo compiles against, so a reordering or a new
 * case must not silently relabel a repair. `runningForeground` is deliberately absent — the runner
 * skips `activate()` there and stamps no fact.
 */
const PRIOR_STATE_BY_RAW_VALUE: Readonly<Record<number, IosTargetActivationPriorState>> = {
  0: 'unknown',
  1: 'notRunning',
  2: 'runningBackground',
  3: 'runningBackgroundSuspended',
};

export function readTargetActivationFact(
  value: unknown,
  /**
   * Notified when `priorState` carries a raw value this table never declared. The decoder stays pure
   * — a log line is the caller's request scope, not this function's — so an unmapped value is both
   * disclosed as `unknown` and named in the log instead of passing unnoticed.
   */
  onUnmappedPriorState?: (detail: UnmappedPriorStateDetail) => void,
): IosTargetActivation | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const fact: Record<string, unknown> = { ...value };
  const reason = fact.reason;
  if (!isIosTargetActivationReason(reason)) return undefined;
  const rawPriorState = fact.priorState;
  if (typeof rawPriorState !== 'number' || !Number.isInteger(rawPriorState)) return undefined;
  const priorState = PRIOR_STATE_BY_RAW_VALUE[rawPriorState];
  if (priorState === undefined) {
    onUnmappedPriorState?.({ reason, rawPriorState });
  }
  const otherActiveApplicationPid = fact.otherActiveApplicationPid;
  return {
    reason,
    // An unmapped raw value is the one case where the repair stays disclosed and only the state
    // degrades: the reason already proves `activate()` ran, and `unknown` is exactly what a raw value
    // this table never declared means. Dropping the fact there would trade a vague disclosure for the
    // silent repair #2682 is about, so the gap is named in the request log instead.
    priorState: priorState ?? 'unknown',
    ...(typeof otherActiveApplicationPid === 'number' &&
    Number.isInteger(otherActiveApplicationPid) &&
    otherActiveApplicationPid > 0
      ? { otherActiveApplicationPid }
      : {}),
  };
}
