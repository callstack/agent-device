import {
  getAndroidAppState,
  getAndroidBlockingDialogFocus,
  openAndroidApp,
  type AndroidBlockingDialogFocus,
} from '../platforms/android/app-lifecycle.ts';
import { snapshotAndroid } from '../platforms/android/snapshot.ts';
import { runAndroidAdb } from '../platforms/android/adb.ts';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import { AppError } from '../kernel/errors.ts';
import { centerOfRect, attachRefs, type SnapshotNode } from '../kernel/snapshot.ts';
import { sleep } from '../utils/timeouts.ts';
import { pruneGroupNodes } from '../snapshot/snapshot-processing.ts';
import { expireRefFrame } from './ref-frame.ts';
import type { SessionState } from './types.ts';

const ANDROID_BLOCKING_MODAL_PATTERN = /\bis(?:n(?:'|&apos;|&#39;)?t| not)\s+responding\b/i;
const ANDROID_CLOSE_APP_PATTERN = /^close app$/i;
const ANDROID_MODAL_POLL_MS = 500;
const ANDROID_MODAL_POLL_ATTEMPTS = 12;
const ANDROID_BLOCKING_DIALOG_HINT =
  'Wait for Android to recover, close the dialog, restart the app, or reboot the emulator, then retry.';

export type AndroidBlockingDialogRecoveryResult =
  | { status: 'absent' }
  | { status: 'recovered' }
  | { status: 'failed'; reason: 'tap-failed' | 'dismiss-failed' | 'relaunch-failed' | 'error' }
  | { status: 'unknown'; reason: 'inspection-failed' };
export type AndroidBlockingDialogReadinessResult =
  | { status: 'clear' }
  | { status: 'recovered'; warning: string };
type AndroidDialogButtonTapResult =
  | { ok: true; x: number; y: number }
  | {
      ok: false;
      exitCode: number;
      stdout: string;
      stderr: string;
    };

export async function recoverAndroidBlockingSystemDialog(params: {
  session: SessionState;
}): Promise<AndroidBlockingDialogRecoveryResult> {
  const { session } = params;

  if (session.device.platform !== 'android' || !session.recording) {
    return { status: 'absent' };
  }

  let nodes: SnapshotNode[];
  try {
    nodes = await readAndroidSnapshotNodes(session);
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'android_blocking_dialog_inspection_failed',
      data: {
        session: session.name,
        deviceId: session.device.id,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return { status: 'unknown', reason: 'inspection-failed' };
  }

  const closeAppButton = findCloseAppButton(nodes);
  if (!closeAppButton?.rect) {
    return { status: 'absent' };
  }

  try {
    const tapResult = await tapAndroidDialogButton(session, closeAppButton);
    if (!tapResult.ok) {
      emitDiagnostic({
        level: 'warn',
        phase: 'android_blocking_dialog_tap_failed',
        data: {
          session: session.name,
          deviceId: session.device.id,
          exitCode: tapResult.exitCode,
          stdout: tapResult.stdout.trim(),
          stderr: tapResult.stderr.trim(),
        },
      });
      return { status: 'failed', reason: 'tap-failed' };
    }

    const dismissed = await waitForBlockingDialogToDismiss(session);
    if (!dismissed) {
      emitDiagnostic({
        level: 'warn',
        phase: 'android_blocking_dialog_still_present',
        data: {
          session: session.name,
          deviceId: session.device.id,
        },
      });
      return { status: 'failed', reason: 'dismiss-failed' };
    }

    if (session.appBundleId) {
      await openAndroidApp(session.device, session.appBundleId);
      const focused = await waitForAndroidAppFocus(session, session.appBundleId);
      if (!focused) {
        emitDiagnostic({
          level: 'warn',
          phase: 'android_blocking_dialog_relaunch_unfocused',
          data: {
            session: session.name,
            deviceId: session.device.id,
            appBundleId: session.appBundleId,
          },
        });
        return { status: 'failed', reason: 'relaunch-failed' };
      }
    }

    emitDiagnostic({
      level: 'warn',
      phase: 'android_blocking_dialog_recovered',
      data: {
        session: session.name,
        deviceId: session.device.id,
        appBundleId: session.appBundleId,
        x: tapResult.x,
        y: tapResult.y,
      },
    });
    return { status: 'recovered' };
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'android_blocking_dialog_recovery_failed',
      data: {
        session: session.name,
        deviceId: session.device.id,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return { status: 'failed', reason: 'error' };
  }
}

export async function ensureAndroidBlockingSystemDialogReady(params: {
  session: SessionState;
  command: string;
  phase: 'before-command' | 'after-command';
}): Promise<AndroidBlockingDialogReadinessResult> {
  const { session, command } = params;
  if (session.device.platform !== 'android') return { status: 'clear' };

  const focus = await getAndroidBlockingDialogFocus(session.device);
  if (!focus) return { status: 'clear' };

  if (isSessionAppAnr(session, focus)) {
    const recovered = await recoverAppOwnedAndroidBlockingSystemDialogSafely(session);
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
    hint: ANDROID_BLOCKING_DIALOG_HINT,
  });
}

async function recoverAppOwnedAndroidBlockingSystemDialogSafely(
  session: SessionState,
): Promise<boolean> {
  try {
    return await recoverAppOwnedAndroidBlockingSystemDialog(session);
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

async function recoverAppOwnedAndroidBlockingSystemDialog(session: SessionState): Promise<boolean> {
  if (!session.appBundleId) return false;

  const nodes = await readAndroidSnapshotNodes(session);
  const closeAppButton = findCloseAppButton(nodes, { requireDialogSignal: false });
  if (!closeAppButton?.rect) return false;

  const tapResult = await tapAndroidDialogButton(session, closeAppButton);
  if (!tapResult.ok) return false;

  await openAndroidApp(session.device, session.appBundleId);
  const focused = await waitForAndroidAppFocus(session, session.appBundleId, {
    requireNoBlockingDialog: true,
  });
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

async function readAndroidSnapshotNodes(session: SessionState): Promise<SnapshotNode[]> {
  const rawSnapshot = await snapshotAndroid(session.device, {
    interactiveOnly: false,
  });
  return attachRefs(pruneGroupNodes(rawSnapshot.nodes));
}

async function tapAndroidDialogButton(
  session: SessionState,
  button: SnapshotNode,
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
  const result = await runAndroidAdb(
    session.device,
    ['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))],
    { allowFailure: true },
  );
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

function findCloseAppButton(
  nodes: SnapshotNode[],
  options: { requireDialogSignal?: boolean } = {},
): SnapshotNode | undefined {
  if (options.requireDialogSignal !== false && !containsBlockingDialog(nodes)) {
    return undefined;
  }
  return nodes.find((node) => {
    return (
      readNodeTextParts(node).some((text) => ANDROID_CLOSE_APP_PATTERN.test(text)) && node.rect
    );
  });
}

async function waitForBlockingDialogToDismiss(session: SessionState): Promise<boolean> {
  for (let attempt = 0; attempt < ANDROID_MODAL_POLL_ATTEMPTS; attempt += 1) {
    const nodes = await readAndroidSnapshotNodes(session);
    if (!containsBlockingDialog(nodes)) {
      return true;
    }
    await sleep(ANDROID_MODAL_POLL_MS);
  }
  const nodes = await readAndroidSnapshotNodes(session);
  return !containsBlockingDialog(nodes);
}

async function waitForAndroidAppFocus(
  session: SessionState,
  appBundleId: string,
  options: { requireNoBlockingDialog?: boolean } = {},
): Promise<boolean> {
  for (let attempt = 0; attempt < ANDROID_MODAL_POLL_ATTEMPTS; attempt += 1) {
    if (await isAndroidAppFocused(session, appBundleId, options)) {
      return true;
    }
    await sleep(ANDROID_MODAL_POLL_MS);
  }
  return await isAndroidAppFocused(session, appBundleId, options);
}

async function isAndroidAppFocused(
  session: SessionState,
  appBundleId: string,
  options: { requireNoBlockingDialog?: boolean },
): Promise<boolean> {
  if (options.requireNoBlockingDialog && (await getAndroidBlockingDialogFocus(session.device))) {
    return false;
  }
  const state = await getAndroidAppState(session.device);
  return state.package === appBundleId;
}

function readNodeText(node: {
  label?: string;
  value?: string | number | boolean | null;
  identifier?: string;
}): string {
  return readNodeTextParts(node).join(' ').trim();
}

function readNodeTextParts(node: {
  label?: string;
  value?: string | number | boolean | null;
  identifier?: string;
}): string[] {
  const parts = [node.label, node.identifier];
  if (typeof node.value === 'string' && node.value.trim().length > 0) {
    parts.push(node.value);
  }
  return parts
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.trim());
}

function containsBlockingDialog(nodes: SnapshotNode[]): boolean {
  return nodes.some((node) => {
    const text = readNodeText(node);
    return text.length > 0 && ANDROID_BLOCKING_MODAL_PATTERN.test(text);
  });
}
