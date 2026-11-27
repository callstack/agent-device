import type {
  AndroidBlockingDialogFocus,
  AndroidObservationAdapter,
} from '@agent-device/contracts/android-observation';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { sleep } from '@agent-device/host-kit/retry';
import { AppError } from '@agent-device/kernel/errors';
import { centerOfRect, type SnapshotNode } from '@agent-device/kernel/snapshot';

import { isSnapshotNodeInteractionBlocked } from '@agent-device/capture-kit/snapshot-occlusion';
import { expireRefFrame } from '../core/ref-frame.ts';
import type { SessionState } from '../core/session-state.ts';
import { isActiveProviderDevice } from '../core/provider-device-admission.ts';

/** The framework id of the ANR dialog's Close app button. It does not depend on the device language. */
const ANDROID_ANR_CLOSE_BUTTON_ID = 'android:id/aerr_close';
const ANDROID_MODAL_POLL_MS = 500;
const ANDROID_MODAL_POLL_ATTEMPTS = 12;
const ANDROID_BLOCKING_DIALOG_HINT =
  'Wait for Android to recover, close the dialog, restart the app, or reboot the emulator, then retry.';
/** `alert` is not stopped by this guard, and it presses the ANR dialog's buttons by their ids. */
const ANDROID_FOREIGN_ANR_HINT =
  'Run alert dismiss to close the app that is not responding, or alert accept to wait for it, then retry.';

export type AndroidBlockingDialogReadinessResult =
  | {
      status: 'clear';
      /** The app package that owned the focused window, when the readiness read named one. */
      focusedPackage?: string;
    }
  | { status: 'recovered'; warning: string };
type AndroidDialogButtonTapResult =
  | { ok: true; x: number; y: number }
  | {
      ok: false;
      exitCode: number;
      stdout: string;
      stderr: string;
    };

function requireObservation(
  observation: AndroidObservationAdapter | undefined,
): AndroidObservationAdapter {
  if (!observation) {
    throw new AppError(
      'INTERNAL_ERROR',
      'Android observation was not supplied by root runtime composition',
    );
  }
  return observation;
}

export async function ensureAndroidBlockingSystemDialogReady(params: {
  session: SessionState;
  command: string;
  phase: 'before-command' | 'after-command';
  observation?: AndroidObservationAdapter;
}): Promise<AndroidBlockingDialogReadinessResult> {
  const { session, command } = params;
  if (session.device.platform !== 'android' || isProviderOwnedSession(session)) {
    return { status: 'clear' };
  }
  const observation = requireObservation(params.observation);

  const dialogObservation = await observation.readBlockingDialog(session.device);
  if (dialogObservation.status !== 'dialog') {
    // "No variant printed the focused window" is not "the device is clear". The command still
    // proceeds — a failed probe has never been a refusal — but the miss is recorded as a miss so
    // it can never be mistaken for evidence about this device.
    if (dialogObservation.status === 'unknown') {
      emitDiagnostic({
        level: 'warn',
        phase: 'android_blocking_dialog_unobserved',
        data: {
          session: session.name,
          deviceId: session.device.id,
          command,
          commandPhase: params.phase,
        },
      });
      return { status: 'clear' };
    }
    return dialogObservation;
  }
  const focus = dialogObservation.focus;

  if (isSessionAppAnr(session, focus)) {
    const recovered = await recoverAppOwnedAndroidBlockingSystemDialogSafely(session, observation);
    if (recovered) {
      const warning = `Recovered Android app ANR before ${command}: closed and relaunched ${session.appBundleId}.`;
      if (params.phase === 'before-command') return { status: 'recovered', warning };

      throw androidBlockingDialogError({
        session,
        command,
        focus,
        message: `Android app ANR appeared after ${command}; ${session.appBundleId} was closed and relaunched. Retry the command against the fresh app session.`,
        hint: 'Retry the command. If the ANR returns, inspect app logs or restart the emulator.',
      });
    }

    throw androidBlockingDialogError({
      session,
      command,
      focus,
      message: `Android app ANR blocked ${command}: ${formatAndroidBlockingDialogFocus(focus)}. Automatic recovery failed.`,
      hint: ANDROID_BLOCKING_DIALOG_HINT,
    });
  }

  throw androidBlockingDialogError({
    session,
    command,
    focus,
    message: `Android system dialog is blocking ${command}: ${formatAndroidBlockingDialogFocus(focus)}.`,
    hint: ANDROID_FOREIGN_ANR_HINT,
  });
}

async function recoverAppOwnedAndroidBlockingSystemDialogSafely(
  session: SessionState,
  observation: AndroidObservationAdapter,
): Promise<boolean> {
  try {
    return await recoverAppOwnedAndroidBlockingSystemDialog(session, observation);
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'android_app_anr_recovery_failed',
      data: {
        session: session.name,
        deviceId: session.device.id,
        appBundleId: session.appBundleId,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return false;
  }
}

function isSessionAppAnr(session: SessionState, focus: AndroidBlockingDialogFocus): boolean {
  return Boolean(session.appBundleId && focus.package === session.appBundleId);
}

async function recoverAppOwnedAndroidBlockingSystemDialog(
  session: SessionState,
  observation: AndroidObservationAdapter,
): Promise<boolean> {
  if (!session.appBundleId) return false;

  const nodes = await readAndroidSnapshotNodes(session, observation);
  const closeAppButton = findCloseAppButton(nodes);
  if (!closeAppButton?.rect) return false;

  const tapResult = await tapAndroidDialogButton(session, closeAppButton, observation);
  if (!tapResult.ok) return false;

  await observation.openApp(session.device, session.appBundleId);
  const focused = await waitForAndroidAppFocus(session, session.appBundleId, observation);
  if (focused) {
    emitDiagnostic({
      level: 'warn',
      phase: 'android_app_anr_recovered',
      data: {
        session: session.name,
        deviceId: session.device.id,
        appBundleId: session.appBundleId,
        x: tapResult.x,
        y: tapResult.y,
      },
    });
  }
  return focused;
}

function androidBlockingDialogError(params: {
  session: SessionState;
  command: string;
  focus: AndroidBlockingDialogFocus;
  message: string;
  hint: string;
}): AppError {
  const { session, command, focus, message, hint } = params;
  return new AppError('COMMAND_FAILED', message, {
    command,
    expectedPackage: session.appBundleId,
    focusedPackage: focus.package,
    focusedWindow: focus.focusedWindow,
    rawFocus: focus.raw,
    hint,
  });
}

function formatAndroidBlockingDialogFocus(focus: AndroidBlockingDialogFocus): string {
  return focus.package ? `${focus.focusedWindow} (package ${focus.package})` : focus.focusedWindow;
}

/**
 * Blocking-dialog detection reads the SAME presentation an agent's `snapshot` would see: one
 * daemon presentation (normalize, group prune, occlusion annotation, refs) rather than a hand-rolled
 * subset that could disagree with it about which button is on top (#1832, the #1784 pattern).
 */
async function readAndroidSnapshotNodes(
  session: SessionState,
  observation: AndroidObservationAdapter,
): Promise<SnapshotNode[]> {
  return await observation.readSnapshotNodes(session.device);
}

async function tapAndroidDialogButton(
  session: SessionState,
  button: SnapshotNode,
  observation: AndroidObservationAdapter,
): Promise<AndroidDialogButtonTapResult> {
  if (!button.rect) {
    return { ok: false, exitCode: 1, stdout: '', stderr: 'button has no rect' };
  }
  const { x, y } = centerOfRect(button.rect);
  // ADR 0014 side-effect seam: blocking-dialog recovery is itself device
  // mutating. Expire the frame before the recovery tap (the first recovery side
  // effect), even when invoked from apparent readiness work, so a ref action
  // cannot continue against the recovered UI.
  expireRefFrame(session);
  const result = await observation.tap(session.device, x, y);
  if (result.exitCode !== 0) {
    return {
      ok: false,
      exitCode: result.exitCode,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  }
  return { ok: true, x, y };
}

/**
 * Recovery acts on what a user can actually touch, so it reads the presentation's structured
 * occlusion result: a stale Close app button left under the foreground surface must not be tapped
 * ahead of the visible one (#1832 review). `buildSnapshotState` already annotates covered nodes;
 * this is the consumer side of that.
 */
function findCloseAppButton(nodes: SnapshotNode[]): SnapshotNode | undefined {
  return nodes.find(
    (node) =>
      node.identifier === ANDROID_ANR_CLOSE_BUTTON_ID &&
      node.rect &&
      !isSnapshotNodeInteractionBlocked(node),
  );
}

async function waitForAndroidAppFocus(
  session: SessionState,
  appBundleId: string,
  observation: AndroidObservationAdapter,
): Promise<boolean> {
  for (let attempt = 0; attempt < ANDROID_MODAL_POLL_ATTEMPTS; attempt += 1) {
    if (await isAndroidAppFocused(session, appBundleId, observation)) {
      return true;
    }
    await sleep(ANDROID_MODAL_POLL_MS);
  }
  return await isAndroidAppFocused(session, appBundleId, observation);
}

/**
 * One window read per poll tick answers both questions this asks, so the loop samples the device
 * once instead of running a dialog probe and a foreground probe an adb round trip apart — which
 * could otherwise report a package read after the dialog check that saw a different screen.
 */
async function isAndroidAppFocused(
  session: SessionState,
  appBundleId: string,
  observation: AndroidObservationAdapter,
): Promise<boolean> {
  return await observation.readAppFocus(session.device, appBundleId, {
    requireNoBlockingDialog: true,
  });
}

function isProviderOwnedSession(session: SessionState): boolean {
  return Boolean(session.lease?.leaseProvider) || isActiveProviderDevice(session.device);
}
