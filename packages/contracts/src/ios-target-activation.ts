/**
 * The Apple runner repairs foreground loss by activating the session app before answering a
 * non-lifecycle command (#2682). That decides which app the answer describes, so the runner stamps
 * the repair on the response of the command that paid for it and this module owns what it means to
 * an agent. `@agent-device/platform-apple`'s runner reader is the single decoder of the wire shape;
 * nothing else parses it.
 *
 * The pid it carries is a liveness claim, not a foreground owner: the private AX client the runner
 * already uses for process matching exposes no ordering of `activeApplications`, resolves pids only,
 * and the escalation that would name an arbitrary app (`proc_pidpath`) has no iOS SDK declaration and
 * no physical-device evidence. So the fact states which other application was alive and leaves the
 * reader to conclude no more than that.
 */

/** Reasons the runner can stamp; mirrors its `activateTarget(bundleId:reason:)` call sites. */
export const IOS_TARGET_ACTIVATION_REASONS = [
  'bundle_changed',
  'stale_target',
  'missing_after_wait',
  'interaction_foreground_guard',
] as const;

export type IosTargetActivationReason = (typeof IOS_TARGET_ACTIVATION_REASONS)[number];

/**
 * States an activation could have been needed for. `runningForeground` is excluded because the
 * runner skips `activate()` when the app is already foreground and never stamps a fact there.
 */
export const IOS_TARGET_ACTIVATION_PRIOR_STATES = [
  'unknown',
  'notRunning',
  'runningBackground',
  'runningBackgroundSuspended',
] as const;

export type IosTargetActivationPriorState = (typeof IOS_TARGET_ACTIVATION_PRIOR_STATES)[number];

/**
 * Foreground repair performed while serving one command. `priorState` is the session app's state
 * BEFORE the runner activated it — read before `activate()` ran — so the fact describes what was
 * repaired rather than what the repair produced, and it can never report `runningForeground`.
 * `otherActiveApplicationPid` is present only when exactly one application other than the session app
 * held an active accessibility session at that moment: proof that it was alive, not proof that it
 * owned the screen.
 */
export type IosTargetActivation = Readonly<{
  reason: IosTargetActivationReason;
  priorState: IosTargetActivationPriorState;
  otherActiveApplicationPid?: number;
}>;

/**
 * What the earlier captures showed. Naming the live pid is a pointer to the only candidate, never a
 * claim that it owned the screen; with no single candidate the reader is told exactly that instead.
 */
function earlierSubject(fact: IosTargetActivation): string {
  return fact.otherActiveApplicationPid === undefined
    ? 'whatever app held the foreground (the runner reported no single other app with an active accessibility session)'
    : `the only app other than the session app with an active accessibility session (pid ${fact.otherActiveApplicationPid})`;
}

/**
 * The one agent-facing sentence for a foreground repair, shared by the Apple capture path and every
 * daemon consumer so the disclosure cannot drop on one route while surviving on another. The
 * disagreement it answers cannot be repaired retroactively, so it names both routes: re-capture now
 * that the session app answers, or drive the other app in its own session. Rebinding a session to
 * whatever came forward is a non-goal of #2682.
 */
export function iosTargetActivationDisclosure(fact: IosTargetActivation): string {
  return (
    `The session app was not foreground when this command arrived (prior state ` +
    `${fact.priorState}), so the runner activated it before answering (reason ${fact.reason}). ` +
    `Any capture taken earlier in this session described ${earlierSubject(fact)}, not the ` +
    'session app. Re-capture now that the session app answers, or drive the other app in its own ' +
    'session.'
  );
}
