/**
 * The ONE decoder of the Apple runner's foreground-repair fact (#2682). The runner stamps the wire
 * shape on the response of the command that activated; this module is the only place it becomes an
 * `IosTargetActivation`. A reason or state the runner never stamps is dropped rather than passed
 * through: an undisclosed repair is a bug, a fabricated one is worse.
 */
import {
  IOS_TARGET_ACTIVATION_PRIOR_STATES,
  IOS_TARGET_ACTIVATION_REASONS,
  type IosTargetActivation,
} from '@agent-device/contracts/ios-target-activation';

/** Wire key on the runner data payload of the command that activated (#2682). */
export const TARGET_ACTIVATION_WIRE_KEY = 'targetActivation';

/** `XCApplicationState` raw value → declared state. `runningForeground` is absent on purpose. */
const PRIOR_STATE_BY_RAW_VALUE: readonly string[] = IOS_TARGET_ACTIVATION_PRIOR_STATES;

export function readTargetActivationFact(value: unknown): IosTargetActivation | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const fact: Record<string, unknown> = { ...value };
  const reason = fact.reason;
  if (
    typeof reason !== 'string' ||
    !(IOS_TARGET_ACTIVATION_REASONS as readonly string[]).includes(reason)
  ) {
    return undefined;
  }
  const rawPriorState = fact.priorState;
  if (typeof rawPriorState !== 'number' || !Number.isInteger(rawPriorState)) return undefined;
  const priorState = PRIOR_STATE_BY_RAW_VALUE[rawPriorState];
  if (priorState === undefined) return undefined;
  const foregroundPid = fact.foregroundPid;
  return {
    reason: reason as IosTargetActivation['reason'],
    priorState: priorState as IosTargetActivation['priorState'],
    ...(typeof foregroundPid === 'number' && Number.isInteger(foregroundPid) && foregroundPid > 0
      ? { foregroundPid }
      : {}),
  };
}
