import {
  type AlertAction,
  ALERT_ACTION_RETRY_MS,
  ALERT_POLL_INTERVAL_MS,
  DEFAULT_ALERT_TIMEOUT_MS,
} from '@agent-device/contracts/alert-contract';
import { AppError } from '@agent-device/kernel/errors';
import { withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import { sleep } from '@agent-device/host-kit/retry';
import { successText } from '@agent-device/kernel/success-text';

import type { DeviceInfo } from '@agent-device/kernel/device';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import {
  chooseAndroidAlertButton,
  findAndroidAlertCandidate,
  type AndroidAlertCandidate,
  type AndroidAlertInfo,
} from './alert-detection.ts';
import { backAndroid, pressAndroid } from './input-actions.ts';

type AndroidAlertOptions = {
  timeoutMs?: number;
  captureNodes: () => Promise<RawSnapshotNode[]>;
};

export type AndroidAlertResult =
  | {
      kind: 'alertStatus';
      platform: 'android';
      action: 'get';
      alert: AndroidAlertInfo | null;
      message?: string;
    }
  | {
      kind: 'alertWait';
      platform: 'android';
      action: 'wait';
      alert: AndroidAlertInfo;
      waitedMs: number;
      message?: string;
    }
  | {
      kind: 'alertHandled';
      platform: 'android';
      action: 'accept' | 'dismiss';
      handled: true;
      alert: AndroidAlertInfo;
      button: string;
      coordinates?: { x: number; y: number };
      message?: string;
    };

export async function handleAndroidAlert(
  device: DeviceInfo,
  action: AlertAction,
  options: AndroidAlertOptions,
): Promise<AndroidAlertResult> {
  if (action === 'wait') {
    return await waitForAndroidAlert(
      options.captureNodes,
      options.timeoutMs ?? DEFAULT_ALERT_TIMEOUT_MS,
    );
  }
  if (action === 'get') {
    const candidate = await readAndroidAlertCandidate(options.captureNodes);
    return buildAndroidAlertStatusResponse(candidate?.alert ?? null);
  }
  return await handleAndroidAlertAction(device, action, options.captureNodes);
}

async function waitForAndroidAlert(
  captureNodes: AndroidAlertOptions['captureNodes'],
  timeoutMs: number,
): Promise<AndroidAlertResult> {
  const start = Date.now();
  const candidate = await pollAndroidAlertCandidate(captureNodes, timeoutMs);
  if (!candidate) {
    throw new AppError('COMMAND_FAILED', 'alert wait timed out');
  }
  return {
    kind: 'alertWait',
    platform: 'android',
    action: 'wait',
    alert: candidate.alert,
    waitedMs: Date.now() - start,
    ...successText('Alert visible'),
  };
}

async function handleAndroidAlertAction(
  device: DeviceInfo,
  action: 'accept' | 'dismiss',
  captureNodes: AndroidAlertOptions['captureNodes'],
): Promise<AndroidAlertResult> {
  const candidate = await pollAndroidAlertCandidate(captureNodes, ALERT_ACTION_RETRY_MS);
  if (!candidate) {
    throw new AppError('COMMAND_FAILED', 'alert not found', {
      hint: 'If a sheet is visible in snapshot but alert reports no alert, it is likely app-owned UI. Use snapshot -i and press the visible label/ref.',
    });
  }

  const button = chooseAndroidAlertButton(candidate.buttons, action);
  if (button) {
    await pressAndroid(device, button.x, button.y);
    await confirmAndroidAlertDismissed(candidate.alert, action, captureNodes);
    return buildAndroidAlertHandledResponse(action, candidate.alert, button.label, {
      x: button.x,
      y: button.y,
    });
  }

  if (action === 'dismiss') {
    await backAndroid(device);
    await confirmAndroidAlertDismissed(candidate.alert, action, captureNodes);
    return buildAndroidAlertHandledResponse(action, candidate.alert, 'Back');
  }

  throw new AppError('COMMAND_FAILED', 'alert accept found an alert but no accept button', {
    alert: candidate.alert,
    hint: 'Inspect alert get --json for visible buttons, then use press by visible label/ref if needed.',
  });
}

/**
 * `alert accept|dismiss` means the dialog is gone, not that a button was pressed: the next
 * command reads the app, and a capture that lands while the dialog window is still up sees
 * only the dialog. A different alert taking its place counts as dismissed. Bounded by the
 * same budget the pre-press lookup uses; iOS's runner applies the same re-check.
 */
async function confirmAndroidAlertDismissed(
  dismissed: AndroidAlertInfo,
  action: 'accept' | 'dismiss',
  captureNodes: AndroidAlertOptions['captureNodes'],
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const current = await readAndroidAlertCandidate(captureNodes);
    if (!current || !sameAndroidAlert(current.alert, dismissed)) return;
    if (Date.now() - start >= ALERT_ACTION_RETRY_MS) {
      throw new AppError('COMMAND_FAILED', `alert ${action} did not dismiss the visible alert`, {
        alert: dismissed,
        hint: 'The alert button was pressed but the dialog is still visible. Inspect alert get --json, then press the visible button by label/ref or retry.',
      });
    }
    await sleep(ALERT_POLL_INTERVAL_MS);
  }
}

function sameAndroidAlert(left: AndroidAlertInfo, right: AndroidAlertInfo): boolean {
  return left.title === right.title && left.buttons.join('\u0000') === right.buttons.join('\u0000');
}

async function pollAndroidAlertCandidate(
  captureNodes: AndroidAlertOptions['captureNodes'],
  timeoutMs: number,
): Promise<AndroidAlertCandidate | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const candidate = await readAndroidAlertCandidate(captureNodes);
    if (candidate) return candidate;
    await sleep(ALERT_POLL_INTERVAL_MS);
  }
  return null;
}

async function readAndroidAlertCandidate(
  captureNodes: AndroidAlertOptions['captureNodes'],
): Promise<AndroidAlertCandidate | null> {
  const result = await withDiagnosticTimer('snapshot_capture', captureNodes, {
    backend: 'android',
    purpose: 'alert',
  });
  return findAndroidAlertCandidate(result);
}

function buildAndroidAlertStatusResponse(alert: AndroidAlertInfo | null): AndroidAlertResult {
  return {
    kind: 'alertStatus',
    platform: 'android',
    action: 'get',
    alert,
    ...(alert ? successText('Alert visible') : successText('No alert visible')),
  };
}

function buildAndroidAlertHandledResponse(
  action: 'accept' | 'dismiss',
  alert: AndroidAlertInfo,
  button: string,
  coordinates?: { x: number; y: number },
): AndroidAlertResult {
  return {
    kind: 'alertHandled',
    platform: 'android',
    action,
    handled: true,
    alert,
    button,
    ...(coordinates ? { coordinates } : {}),
    ...successText(`Alert ${action}ed`),
  };
}
