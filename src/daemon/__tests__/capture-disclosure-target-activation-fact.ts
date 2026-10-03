import type { IosTargetActivation } from '@agent-device/kernel/snapshot';

/** The repair stamp every capture-disclosure suite drives. */
export const TARGET_ACTIVATION_FACT: IosTargetActivation = {
  reason: 'stale_target',
  priorState: 'runningBackground',
  otherActiveApplicationPid: 4562,
};
