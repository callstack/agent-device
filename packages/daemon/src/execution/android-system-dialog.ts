import type {
  AndroidBlockingDialogFocus,
  AndroidObservationAdapter,
} from '@agent-device/contracts/android-observation';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { sleep } from '@agent-device/host-kit/retry';
import {
  AppError,
  discloseDispatch,
  normalizeError,
  type NormalizedError,
} from '@agent-device/kernel/errors';
import { centerOfRect, type Point, type SnapshotNode } from '@agent-device/kernel/snapshot';

import { isSnapshotNodeInteractionBlocked } from '@agent-device/capture-kit/snapshot-occlusion';
import { expireRefFrame } from '../core/ref-frame.ts';
import { thrownBeforeDispatch } from './request-dispatch-disclosure.ts';
import type { SessionState } from '../core/session-state.ts';
import { isActiveProviderDevice } from '../core/provider-device-admission.ts';

const ANDROID_BLOCKING_MODAL_PATTERN = /\bis(?:n(?:'|&apos;|&#39;)?t| not)\s+responding\b/i;
const ANDROID_CLOSE_APP_PATTERN = /^close app$/i;
/**
 * The ANR dialog's (`AppNotRespondingDialog`) Close app and Wait buttons. The resource id does not
 * depend on the device language, and an app cannot declare an id in the `android` package.
 */
const ANDROID_ANR_DIALOG_BUTTON_IDS: ReadonlySet<string> = new Set([
  'android:id/aerr_close',
  'android:id/aerr_wait',
]);
const ANDROID_MODAL_POLL_MS = 500;
const ANDROID_MODAL_POLL_ATTEMPTS = 12;
const ANDROID_BLOCKING_DIALOG_HINT =
  'Wait for Android to recover, close the dialog, restart the app, or reboot the emulator, then retry.';
const ANDROID_FOREIGN_DIALOG_HINT =
  "Take a new snapshot -i, then press the ref of one of the dialog's buttons (Close app or Wait). Every other input is refused while the dialog has focus.";
const ANDROID_BLOCKING_DIALOG_INSPECTION_WARNING =
  'Android blocking-dialog readiness could not be inspected; the command continued.';
const ANDROID_BLOCKING_DIALOG_WARNING_TEXT_LIMIT = 240;

export type AndroidBlockingDialogRecoveryResult =
  | { status: 'absent' }
  | { status: 'recovered' }
  | { status: 'failed'; reason: 'tap-failed' | 'dismiss-failed' | 'relaunch-failed' | 'error' }
  | { status: 'unknown'; reason: 'inspection-failed'; warning: string };
export type AndroidBlockingDialogReadinessResult =
  | {
      status: 'clear';
      /** The app package that owned the focused window, when the readiness read named one. */
      focusedPackage?: string;
    }
  | { status: 'recovered'; warning: string };

/**
 * What a single press or click aims at, read before dispatch: the node a ref names in the session
 * snapshot, a raw point, or a selector.
 */
export type AndroidDialogTapTarget =
  | { kind: 'ref'; node: SnapshotNode | undefined }
  | { kind: 'point'; point: Point }
  | { kind: 'selector' };

export type AndroidBlockingDialogTapReadinessResult =
  | AndroidBlockingDialogReadinessResult
  | { status: 'dialog-button' };
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

export async function recoverAndroidBlockingSystemDialog(params: {
  session: SessionState;
  observation?: AndroidObservationAdapter;
}): Promise<AndroidBlockingDialogRecoveryResult> {
  const { session } = params;

  if (
    session.device.platform !== 'android' ||
    !session.screenRecording ||
    isProviderOwnedSession(session)
  ) {
    return { status: 'absent' };
  }
  const observation = requireObservation(params.observation);

  let nodes: SnapshotNode[];
  try {
    nodes = await readAndroidSnapshotNodes(session, observation);
  } catch (error) {
    const normalizedError = normalizeError(error);
    emitDiagnostic({
      level: 'warn',
      phase: 'android_blocking_dialog_inspection_failed',
      data: {
        session: session.name,
        deviceId: session.device.id,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return {
      status: 'unknown',
      reason: 'inspection-failed',
      warning: androidBlockingDialogInspectionWarning(normalizedError),
    };
  }

  const closeAppButton = findCloseAppButton(nodes);
  if (!closeAppButton?.rect) {
    return { status: 'absent' };
  }

  try {
    const tapResult = await tapAndroidDialogButton(session, closeAppButton, observation);
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

    const dismissed = await waitForBlockingDialogToDismiss(session, observation);
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
      await observation.openApp(session.device, session.appBundleId);
      const focused = await waitForAndroidAppFocus(session, session.appBundleId, observation);
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
  observation?: AndroidObservationAdapter;
}): Promise<AndroidBlockingDialogReadinessResult> {
  const readiness = await readAndroidBlockingSystemDialogReadiness(params);
  if (readiness.status === 'foreign-dialog') throw readiness.refusal();
  return readiness;
}

/**
 * The before-command check of a single press or click. A foreign ANR dialog ("System UI isn't
 * responding") refuses every other input, so its Close app and Wait buttons are the only way to
 * close it from a command. The tap proceeds with `dialog-button` only when it aims at one of them
 * in a fresh capture and the dialog still has focus; otherwise it is refused with nothing sent.
 */
export async function ensureAndroidBlockingSystemDialogReadyForTap(params: {
  session: SessionState;
  command: string;
  target: AndroidDialogTapTarget;
  observation?: AndroidObservationAdapter;
}): Promise<AndroidBlockingDialogTapReadinessResult> {
  const readiness = await readAndroidBlockingSystemDialogReadiness({
    ...params,
    phase: 'before-command',
  });
  if (readiness.status !== 'foreign-dialog') return readiness;
  const { session, command } = params;
  const observation = requireObservation(params.observation);
  let buttons: SnapshotNode[];
  try {
    buttons = findAnrDialogButtons(await readAndroidSnapshotNodes(session, observation));
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'android_blocking_dialog_buttons_unread',
      data: {
        session: session.name,
        deviceId: session.device.id,
        command,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw readiness.refusal();
  }
  // Before Android 7.0, the dialog's buttons carry no `aerr_` ids, so no press can close it.
  if (buttons.length === 0) throw readiness.refusal();
  if (!aimsAtAnrDialogButton(buttons, params.target)) {
    throw readiness.refusal(ANDROID_FOREIGN_DIALOG_HINT);
  }
  await confirmAndroidBlockingDialogFocus(session, command, readiness.focus, observation);
  return { status: 'dialog-button' };
}

/**
 * A ref must name a Close app or Wait node, and the button with the same id in the fresh capture
 * must contain that node's center: so a ref read before the dialog appeared, or a Wait ref whose
 * stored position now shows Close app, is refused. A raw point must be inside either button.
 */
function aimsAtAnrDialogButton(buttons: SnapshotNode[], target: AndroidDialogTapTarget): boolean {
  if (target.kind === 'point') return findButtonAtPoint(buttons, target.point) !== undefined;
  if (target.kind !== 'ref' || !target.node?.rect) return false;
  const button = findButtonAtPoint(buttons, centerOfRect(target.node.rect));
  return button !== undefined && button.identifier === target.node.identifier;
}

/**
 * Reads the focus again as the last step of readiness, before ref resolution and the send. The
 * buttons came from a capture, so if the dialog lost focus since then, a tap at their points could
 * reach what the dialog uncovered.
 */
async function confirmAndroidBlockingDialogFocus(
  session: SessionState,
  command: string,
  focus: AndroidBlockingDialogFocus,
  observation: AndroidObservationAdapter,
): Promise<void> {
  const current = await observation.readBlockingDialog(session.device).catch((error: unknown) => {
    throw thrownBeforeDispatch(error);
  });
  if (current.status === 'dialog' && isSameAndroidBlockingDialogFocus(current.focus, focus)) return;
  const dialog = formatAndroidBlockingDialogFocus(focus);
  const message =
    current.status === 'dialog'
      ? `Android system dialog is blocking ${command}: ${formatAndroidBlockingDialogFocus(current.focus)}.`
      : current.status === 'unknown'
        ? `Android focus could not be read to confirm that the system dialog still has focus before ${command} was sent: ${dialog}.`
        : `Android system dialog lost focus before ${command} was sent: ${dialog}.`;
  throw discloseDispatch(
    androidBlockingDialogError({
      session,
      command,
      focus: current.status === 'dialog' ? current.focus : focus,
      message,
      hint: 'Nothing was sent. Take a new snapshot, then retry the command.',
    }),
    'no',
  );
}

function isSameAndroidBlockingDialogFocus(
  a: AndroidBlockingDialogFocus,
  b: AndroidBlockingDialogFocus,
): boolean {
  return a.package === b.package && a.focusedWindow === b.focusedWindow;
}

/**
 * Android's view hit test excludes the right and bottom edges, so a point on them reaches the
 * dialog around the button, not the button.
 */
function findButtonAtPoint(buttons: SnapshotNode[], point: Point): SnapshotNode | undefined {
  return buttons.find(
    ({ rect }) =>
      rect !== undefined &&
      point.x >= rect.x &&
      point.x < rect.x + rect.width &&
      point.y >= rect.y &&
      point.y < rect.y + rect.height,
  );
}

/**
 * After a tap on a dialog button, Android removes the dialog window asynchronously. Waits a bounded
 * time for the focus to leave the dialog, so the after-command check reads the result of the tap
 * and not the frame before it.
 */
export async function waitForAndroidBlockingDialogFocusToClear(
  session: SessionState,
  observation: AndroidObservationAdapter | undefined,
): Promise<void> {
  const adapter = requireObservation(observation);
  for (let attempt = 0; attempt < ANDROID_MODAL_POLL_ATTEMPTS; attempt += 1) {
    const dialog = await adapter.readBlockingDialog(session.device);
    if (dialog.status !== 'dialog') return;
    await sleep(ANDROID_MODAL_POLL_MS);
  }
}

type AndroidBlockingSystemDialogReadiness =
  | AndroidBlockingDialogReadinessResult
  | {
      status: 'foreign-dialog';
      focus: AndroidBlockingDialogFocus;
      /** `hint` defaults to recovery steps; a press that may target the buttons passes its own. */
      refusal: (hint?: string) => AppError;
    };

async function readAndroidBlockingSystemDialogReadiness(params: {
  session: SessionState;
  command: string;
  phase: 'before-command' | 'after-command';
  observation?: AndroidObservationAdapter;
}): Promise<AndroidBlockingSystemDialogReadiness> {
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

  return {
    status: 'foreign-dialog',
    focus,
    refusal: (hint = ANDROID_BLOCKING_DIALOG_HINT) => {
      const error = androidBlockingDialogError({
        session,
        command,
        focus,
        message: `Android system dialog is blocking ${command}: ${formatAndroidBlockingDialogFocus(focus)}.`,
        hint,
      });
      // ADR 0039: before the command, the refusal sends nothing. After it, the command's own
      // dispatch ledger discloses what was sent.
      return params.phase === 'before-command' ? discloseDispatch(error, 'no') : error;
    },
  };
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
  const closeAppButton = findCloseAppButton(nodes, { requireDialogSignal: false });
  if (!closeAppButton?.rect) return false;

  const tapResult = await tapAndroidDialogButton(session, closeAppButton, observation);
  if (!tapResult.ok) return false;

  await observation.openApp(session.device, session.appBundleId);
  const focused = await waitForAndroidAppFocus(session, session.appBundleId, observation, {
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

function androidBlockingDialogInspectionWarning(error: NormalizedError): string {
  const details = [`Inspection error: ${boundAndroidWarningText(error.message)}`];
  if (error.hint) details.push(`Hint: ${boundAndroidWarningText(error.hint)}`);
  return [ANDROID_BLOCKING_DIALOG_INSPECTION_WARNING, ...details].join(' ');
}

function boundAndroidWarningText(value: string): string {
  const singleLine = value.replaceAll(/\s+/g, ' ').trim();
  if (singleLine.length <= ANDROID_BLOCKING_DIALOG_WARNING_TEXT_LIMIT) return singleLine;
  return `${singleLine.slice(0, ANDROID_BLOCKING_DIALOG_WARNING_TEXT_LIMIT - 1)}…`;
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
 * Recovery acts on what a user can actually touch, so both decisions read the presentation's
 * structured occlusion result rather than raw text: a stale "Close app" left under the foreground
 * surface must neither trigger recovery nor be tapped ahead of the visible one (#1832 review).
 * `buildSnapshotState` already annotates covered nodes; this is the consumer side of that.
 */
function findCloseAppButton(
  nodes: SnapshotNode[],
  options: { requireDialogSignal?: boolean } = {},
): SnapshotNode | undefined {
  if (options.requireDialogSignal !== false && !containsBlockingDialog(nodes)) {
    return undefined;
  }
  return nodes.filter(isTouchableDialogNode).find((node) => {
    return (
      readNodeTextParts(node).some((text) => ANDROID_CLOSE_APP_PATTERN.test(text)) && node.rect
    );
  });
}

/** A node the recovery tap can actually reach: present in the tree and not covered by a surface above it. */
function isTouchableDialogNode(node: SnapshotNode): boolean {
  return !isSnapshotNodeInteractionBlocked(node);
}

async function waitForBlockingDialogToDismiss(
  session: SessionState,
  observation: AndroidObservationAdapter,
): Promise<boolean> {
  for (let attempt = 0; attempt < ANDROID_MODAL_POLL_ATTEMPTS; attempt += 1) {
    const nodes = await readAndroidSnapshotNodes(session, observation);
    if (!containsBlockingDialog(nodes)) {
      return true;
    }
    await sleep(ANDROID_MODAL_POLL_MS);
  }
  const nodes = await readAndroidSnapshotNodes(session, observation);
  return !containsBlockingDialog(nodes);
}

async function waitForAndroidAppFocus(
  session: SessionState,
  appBundleId: string,
  observation: AndroidObservationAdapter,
  options: { requireNoBlockingDialog?: boolean } = {},
): Promise<boolean> {
  for (let attempt = 0; attempt < ANDROID_MODAL_POLL_ATTEMPTS; attempt += 1) {
    if (await isAndroidAppFocused(session, appBundleId, observation, options)) {
      return true;
    }
    await sleep(ANDROID_MODAL_POLL_MS);
  }
  return await isAndroidAppFocused(session, appBundleId, observation, options);
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
  options: { requireNoBlockingDialog?: boolean },
): Promise<boolean> {
  return await observation.readAppFocus(session.device, appBundleId, options);
}

function isProviderOwnedSession(session: SessionState): boolean {
  return Boolean(session.lease?.leaseProvider) || isActiveProviderDevice(session.device);
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

/**
 * The ANR dialog's touchable Close app and Wait buttons, read by resource id: the dialog's text is in
 * the device language.
 */
function findAnrDialogButtons(nodes: SnapshotNode[]): SnapshotNode[] {
  return nodes
    .filter(isTouchableDialogNode)
    .filter(
      (node) =>
        node.rect !== undefined &&
        node.identifier !== undefined &&
        ANDROID_ANR_DIALOG_BUTTON_IDS.has(node.identifier),
    );
}

function containsBlockingDialog(nodes: SnapshotNode[]): boolean {
  return nodes.filter(isTouchableDialogNode).some((node) => {
    const text = readNodeText(node);
    return text.length > 0 && ANDROID_BLOCKING_MODAL_PATTERN.test(text);
  });
}
