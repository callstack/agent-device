/**
 * The Apple runner repairs foreground loss by activating the session app before answering a
 * non-lifecycle command (#2682). That decides which app the answer describes, so the runner stamps
 * the repair on the response of the command that paid for it. `@agent-device/kernel/snapshot` owns
 * the fact — it travels on a captured tree's state — and `@agent-device/platform-apple`'s runner
 * reader is the single decoder of the wire shape. This module owns only what the fact says to an
 * agent, so the sentence cannot drift between the capture path and the daemon routes.
 *
 * The pid it carries is a liveness claim, not a foreground owner: the private AX client the runner
 * already uses for process matching exposes no ordering of `activeApplications`, resolves pids only,
 * and the escalation that would name an arbitrary app (`proc_pidpath`) has no iOS SDK declaration and
 * no physical-device evidence. So the fact states which other application was alive and leaves the
 * reader to conclude no more than that.
 */
import type { IosTargetActivation } from '@agent-device/kernel/snapshot';

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
