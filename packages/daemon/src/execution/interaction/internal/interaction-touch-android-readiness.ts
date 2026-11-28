import type { DaemonResponse } from '@agent-device/kernel/contracts';
import {
  ensureAndroidBlockingSystemDialogReady,
  type AndroidBlockingDialogReadinessResult,
} from '../../android-system-dialog.ts';
import type { SessionState } from '../../../core/session-state.ts';
import { readRefMutationFrame } from '../../../core/ref-frame.ts';
import { refMutationAdmissionResponse } from './interaction-ref-policy.ts';
import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';

/**
 * How Android blocking-dialog readiness composes with `@ref` admission and the route's post-dispatch
 * guard around a touch dispatch: recovery is device-mutating, so it must not silently retarget an
 * admitted ref, and the guard judges on the readiness read that already looked at the screen after
 * the action.
 */

export type RefAdmissionContext = {
  ref: string;
  mintedGeneration: number | undefined;
  staleRefsWarning: string | undefined;
};

export type ReadinessOutcome<TResult> =
  | { aborted: true; response: DaemonResponse }
  | {
      aborted: false;
      /** The before-command readiness read, whose `recovered` warning the caller reports. */
      readiness: AndroidBlockingDialogReadinessResult;
      runtimeResult: TResult;
      /** What {@link AndroidDispatchOptions.judgeAfterReadiness} returned. */
      warning?: string;
    };

/**
 * The focused package a readiness read named, when it named one. A read that recovered, or a route
 * that ran none, names no package — that is no evidence about who owned the focused window.
 */
export function focusedPackageOf(
  readiness: AndroidBlockingDialogReadinessResult,
): string | undefined {
  return readiness.status === 'clear' ? readiness.focusedPackage : undefined;
}

export type AndroidDispatchOptions<TResult> = {
  refContext: RefAdmissionContext | undefined;
  /**
   * The route's verdict on what the dispatch left on screen — an escape guard, for a touch. It runs
   * after the after-command readiness read, with that read and the before-command one, so it judges
   * on the later observation of the same screen instead of spending a read of its own.
   */
  judgeAfterReadiness?: (
    result: TResult,
    afterReadiness: AndroidBlockingDialogReadinessResult,
    beforeReadiness: AndroidBlockingDialogReadinessResult,
  ) => Promise<string | undefined> | undefined;
};

export async function runWithAndroidDialogReadinessCheck<TResult>(
  session: SessionState,
  command: string,
  options: AndroidDispatchOptions<TResult>,
  run: () => Promise<TResult>,
  observation?: AndroidObservationAdapter,
): Promise<ReadinessOutcome<TResult>> {
  const { refContext, judgeAfterReadiness } = options;
  if (session.lease?.leaseProvider) {
    // No readiness read on this route, so the guard gets none: it observes for itself.
    const noReadiness: AndroidBlockingDialogReadinessResult = { status: 'clear' };
    const runtimeResult = await run();
    const warning = await judgeAfterReadiness?.(runtimeResult, noReadiness, noReadiness);
    return { aborted: false, readiness: noReadiness, runtimeResult, warning };
  }
  const readiness = await ensureAndroidBlockingSystemDialogReady({
    session,
    command,
    phase: 'before-command',
    observation,
  });
  // ADR 0014: blocking-dialog recovery is itself device-mutating and expires the
  // frame at its own seam. A ref action admitted against the pre-recovery frame
  // must NOT continue against the recovered UI — abort it through the SHARED
  // admission rejection so the failure shape (reason, ref, currentGeneration,
  // scope, mintedGeneration, hint) is identical to every other expired-frame
  // rejection across platforms. Selector/coordinate actions carry no refContext
  // and re-resolve and continue under their own policy.
  if (refContext && readiness.status === 'recovered') {
    const abort = refMutationAdmissionResponse({
      ref: refContext.ref,
      mintedGeneration: refContext.mintedGeneration,
      staleRefsWarning: refContext.staleRefsWarning,
      frame: readRefMutationFrame({
        session,
        ref: refContext.ref,
        mintedGeneration: refContext.mintedGeneration,
      }),
    });
    if (abort) return { aborted: true, response: abort };
  }
  const runtimeResult = await run();
  // The after-command readiness read runs before the guard judges, so the guard decides on the
  // later look at the screen the dispatch changed. Its precedence follows: a blocking dialog or an
  // app ANR that appeared with the transition is refused here, and it is device-mutating recovery
  // that relaunches the app, so an escape verdict over it would describe UI the recovery already
  // replaced. A dispatch that threw never reaches either: an action the device never performed
  // owes neither the read nor an escape verdict.
  const afterReadiness = await ensureAndroidBlockingSystemDialogReady({
    session,
    command,
    phase: 'after-command',
    observation,
  });
  const warning = await judgeAfterReadiness?.(runtimeResult, afterReadiness, readiness);
  return { aborted: false, readiness, runtimeResult, warning };
}
