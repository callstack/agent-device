import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  getLiveAndroidSnapshotHelperSession,
  stopAndroidSnapshotHelperSession,
} from './snapshot-helper-session-lifecycle.ts';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { getAndroidSnapshotHelperSessionDeviceKey } from './snapshot-helper-retirement.ts';
import { runAndroidSnapshotHelperSessionTouchCommand } from './snapshot-helper-session.ts';
import {
  prepareAndroidAutomationHelper,
  androidAutomationHelperIdentity,
} from './automation-helper-artifact.ts';

export type AndroidHelperInput =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'key'; keyCode: number }
  | { kind: 'fill'; x: number; y: number; text: string };

type AndroidAutomationRequest =
  | { action: 'input'; input: AndroidHelperInput }
  | { action: 'app'; input: { kind: 'open'; packageName: string } }
  | { action: 'screenshot' }
  | { action: 'focus' };

type AndroidHelperFocus = { focusedPackage?: string; windowType?: string };
type AndroidHelperAppResult =
  | { kind: 'component-unavailable' }
  | { kind: 'launched'; output: string };

const ACTION_POLICY = {
  input: { mutation: true, timeoutMs: 30_000 },
  app: { mutation: true, timeoutMs: 30_000 },
  screenshot: { mutation: false, timeoutMs: 30_000 },
  focus: { mutation: false, timeoutMs: 2_000 },
} as const;

/** Reuses the session's automation context without starting instrumentation for sessionless input. */
export function runAndroidAutomationHelper(
  device: DeviceInfo,
  request: Extract<AndroidAutomationRequest, { action: 'input' }>,
): Promise<true | undefined>;
export function runAndroidAutomationHelper(
  device: DeviceInfo,
  request: Extract<AndroidAutomationRequest, { action: 'screenshot' }>,
): Promise<Buffer | undefined>;
export function runAndroidAutomationHelper(
  device: DeviceInfo,
  request: Extract<AndroidAutomationRequest, { action: 'focus' }>,
): Promise<AndroidHelperFocus | undefined>;
export function runAndroidAutomationHelper(
  device: DeviceInfo,
  request: Extract<AndroidAutomationRequest, { action: 'app' }>,
): Promise<AndroidHelperAppResult | undefined>;
export async function runAndroidAutomationHelper(
  device: DeviceInfo,
  request: AndroidAutomationRequest,
): Promise<true | AndroidHelperAppResult | Buffer | AndroidHelperFocus | undefined> {
  const { action } = request;
  const deviceKey = getAndroidSnapshotHelperSessionDeviceKey(device);
  if (!(await getLiveAndroidSnapshotHelperSession(deviceKey))?.commands.has(action))
    return undefined;
  const prepared = await prepareAndroidAutomationHelper(device);
  try {
    const headers = await runAndroidSnapshotHelperSessionTouchCommand({
      deviceKey,
      action,
      helper: androidAutomationHelperIdentity(prepared.artifact),
      payloadBase64:
        'input' in request
          ? Buffer.from(JSON.stringify(request.input)).toString('base64')
          : undefined,
      timeoutMs: ACTION_POLICY[action].timeoutMs,
    });
    if (!headers) return undefined;
    switch (action) {
      case 'input':
        return true;
      case 'screenshot':
        return decodeHelperPayload(headers, 'payloadBase64', false);
      case 'focus':
        return { focusedPackage: headers.focusedPackage, windowType: headers.windowType };
      case 'app':
        return headers.componentUnavailable === 'true'
          ? { kind: 'component-unavailable' }
          : {
              kind: 'launched',
              output: decodeHelperPayload(headers, 'launchOutputBase64', true).toString('utf8'),
            };
    }
  } catch (error) {
    if (
      ACTION_POLICY[action].mutation &&
      !(error instanceof AppError && error.details?.dispatched === 'no')
    )
      throw error;
    await stopAndroidSnapshotHelperSession(deviceKey);
    emitDiagnostic({
      level: 'warn',
      phase: `android_helper_${action}_fallback`,
      data: {
        error: error instanceof Error ? error.message : String(error),
        dispatched: error instanceof AppError ? error.details?.dispatched : undefined,
      },
    });
    return undefined;
  }
}

function decodeHelperPayload(
  headers: Record<string, string>,
  field: string,
  allowEmpty: boolean,
): Buffer {
  const encoded = headers[field];
  const bytes = encoded === undefined ? undefined : Buffer.from(encoded, 'base64');
  if (!bytes || (!allowEmpty && bytes.length === 0) || bytes.toString('base64') !== encoded) {
    throw new AppError('COMMAND_FAILED', 'Android automation helper returned malformed payload', {
      field,
    });
  }
  return bytes;
}
