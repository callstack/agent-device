import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { Point, SnapshotNode } from '@agent-device/kernel/snapshot';
import {
  ensureAndroidBlockingSystemDialogReady,
  ensureAndroidBlockingSystemDialogReadyForTap,
  isAndroidBlockingDialogButtonPoint,
  waitForAndroidBlockingDialogFocusToClear,
  type AndroidBlockingDialogButtonAdmission,
  type AndroidBlockingDialogTapReadinessResult,
} from '../../android-system-dialog.ts';
import type { SessionState } from '../../../core/session-state.ts';
import { readRefMutationFrame } from '../../../core/ref-frame.ts';
import { refMutationAdmissionResponse } from './interaction-ref-policy.ts';
import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';

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
      readiness: AndroidBlockingDialogTapReadinessResult;
      runtimeResult: TResult;
    };

/**
 * The per-request gate of a single tap while a foreign app-error dialog has focus. Readiness opens
 * it with the dialog's buttons; the backend calls `admitTap` immediately before it sends the tap
 * (and before the ref frame expires). Only one tap, on one of the dialog's buttons, passes, and only
 * while the dialog still has focus. Any other tap is refused with `dispatched: no`.
 */
export type AndroidDialogTapGate = Readonly<{
  open(admission: AndroidBlockingDialogButtonAdmission): void;
  admitTap(point: Point | undefined, resolvedOn?: SnapshotNode[]): Promise<void>;
}>;

export function createAndroidDialogTapGate(): AndroidDialogTapGate {
  let admission: AndroidBlockingDialogButtonAdmission | undefined;
  let admittedTaps = 0;
  return {
    open: (next) => {
      admission = next;
    },
    admitTap: async (point, resolvedOn) => {
      if (!admission) return;
      if (
        admittedTaps > 0 ||
        !point ||
        !isAndroidBlockingDialogButtonPoint(admission, point, resolvedOn)
      ) {
        throw admission.refusal();
      }
      await admission.confirmFocus();
      admittedTaps += 1;
    },
  };
}

export async function runWithAndroidDialogReadinessCheck<TResult>(
  session: SessionState,
  command: string,
  options: { refContext: RefAdmissionContext | undefined; dialogTapGate?: AndroidDialogTapGate },
  run: (readiness: AndroidBlockingDialogTapReadinessResult) => Promise<TResult>,
  observation?: AndroidObservationAdapter,
): Promise<ReadinessOutcome<TResult>> {
  if (session.lease?.leaseProvider) {
    const readiness = { status: 'clear' } as const;
    return { aborted: false, readiness, runtimeResult: await run(readiness) };
  }
  const readiness: AndroidBlockingDialogTapReadinessResult = options.dialogTapGate
    ? await ensureAndroidBlockingSystemDialogReadyForTap({ session, command, observation })
    : await ensureAndroidBlockingSystemDialogReady({
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
  if (options.refContext && readiness.status === 'recovered') {
    const abort = refMutationAdmissionResponse({
      ref: options.refContext.ref,
      mintedGeneration: options.refContext.mintedGeneration,
      staleRefsWarning: options.refContext.staleRefsWarning,
      frame: readRefMutationFrame({
        session,
        ref: options.refContext.ref,
        mintedGeneration: options.refContext.mintedGeneration,
      }),
    });
    if (abort) return { aborted: true, response: abort };
  }
  if (readiness.status === 'dialog-buttons') options.dialogTapGate?.open(readiness.admission);
  const runtimeResult = await run(readiness);
  if (readiness.status === 'dialog-buttons') {
    await waitForAndroidBlockingDialogFocusToClear(session, observation);
  }
  await ensureAndroidBlockingSystemDialogReady({
    session,
    command,
    phase: 'after-command',
    observation,
  });
  return { aborted: false, readiness, runtimeResult };
}
