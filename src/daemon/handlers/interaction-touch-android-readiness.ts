import {
  ensureAndroidBlockingSystemDialogReady,
  type AndroidBlockingDialogReadinessResult,
} from '../android-system-dialog.ts';
import type { DaemonResponse, SessionState } from '../types.ts';
import { refMutationAdmissionResponse } from './interaction-ref-policy.ts';

/**
 * How Android blocking-dialog readiness composes with `@ref` admission around a
 * touch dispatch: recovery is device-mutating, so it must not silently retarget
 * an admitted ref.
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
      readiness: AndroidBlockingDialogReadinessResult;
      runtimeResult: TResult;
    };

export async function runWithAndroidDialogReadinessCheck<TResult>(
  session: SessionState,
  command: string,
  options: { refContext: RefAdmissionContext | undefined },
  run: () => Promise<TResult>,
): Promise<ReadinessOutcome<TResult>> {
  if (session.lease?.leaseProvider) {
    return { aborted: false, readiness: { status: 'clear' }, runtimeResult: await run() };
  }
  const readiness = await ensureAndroidBlockingSystemDialogReady({
    session,
    command,
    phase: 'before-command',
  });
  // ADR 0014: blocking-dialog recovery is itself device-mutating and expires the
  // frame at its own seam. A ref action admitted against the pre-recovery frame
  // must NOT continue against the recovered UI — abort it through the SHARED
  // admission rejection so the failure shape (reason, ref, currentGeneration,
  // scope, mintedGeneration, hint) is identical to every other expired-frame
  // rejection across platforms. Selector/coordinate actions carry no refContext
  // and re-resolve and continue under their own policy.
  if (options.refContext && readiness.status === 'recovered') {
    const abort = refMutationAdmissionResponse({
      session,
      ref: options.refContext.ref,
      mintedGeneration: options.refContext.mintedGeneration,
      staleRefsWarning: options.refContext.staleRefsWarning,
    });
    if (abort) return { aborted: true, response: abort };
  }
  const runtimeResult = await run();
  await ensureAndroidBlockingSystemDialogReady({
    session,
    command,
    phase: 'after-command',
  });
  return { aborted: false, readiness, runtimeResult };
}
