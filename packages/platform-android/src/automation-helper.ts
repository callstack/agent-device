import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  getLiveAndroidSnapshotHelperSession,
  stopAndroidSnapshotHelperSession,
} from './snapshot-helper-session-lifecycle.ts';
import { emitDiagnostic, getDiagnosticsMeta } from '@agent-device/host-kit/diagnostics';
import { getRequestDeadlineMs } from '@agent-device/host-kit/request';
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
/**
 * `displays` is absent when the helper predates the display headers or could not read its displays.
 * `rotationIndex` is the default display's logical `Surface.ROTATION_*` index, absent when the
 * display turned during the capture or the read failed.
 */
export type AndroidHelperScreenshot = {
  png: Buffer;
  displays?: { count: number; rotationIndex?: number };
};
type AndroidHelperAppResult =
  | { kind: 'component-unavailable' }
  | { kind: 'launched'; output: string };

const ACTION_POLICY = {
  // Less the 5 s answer margin, a 40 s helper budget lets a start refused at once still afford its
  // one retry (PressSequence.RETRY_WORST_CASE_MS, 35 s); a later refusal is not retried.
  input: { mutation: true, timeoutMs: 45_000 },
  app: { mutation: true, timeoutMs: 30_000 },
  screenshot: { mutation: false, timeoutMs: 30_000 },
  focus: { mutation: false, timeoutMs: 2_000 },
} as const;

/** The helper must answer input this long before the host timeout so its typed result arrives. */
const INPUT_ANSWER_MARGIN_MS = 5_000;

/**
 * The least wait a press is sent with: one injection attempt round trip. On an emulator a whole
 * press takes 0.25-0.4 s through the helper or `adb shell input`, so 2 s keeps a wide margin;
 * with less, neither path can be expected to answer before the host stops waiting.
 */
const MIN_INPUT_ATTEMPT_MS = 2_000;

/** Reuses the session's automation context without starting instrumentation for sessionless input. */
export function runAndroidAutomationHelper(
  device: DeviceInfo,
  request: Extract<AndroidAutomationRequest, { action: 'input' }>,
): Promise<true | undefined>;
export function runAndroidAutomationHelper(
  device: DeviceInfo,
  request: Extract<AndroidAutomationRequest, { action: 'screenshot' }>,
): Promise<AndroidHelperScreenshot | undefined>;
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
): Promise<
  true | AndroidHelperAppResult | AndroidHelperScreenshot | AndroidHelperFocus | undefined
> {
  const { action } = request;
  const deviceKey = getAndroidSnapshotHelperSessionDeviceKey(device);
  if (!(await getLiveAndroidSnapshotHelperSession(deviceKey))?.commands.has(action))
    return undefined;
  const timeoutMs = action === 'input' ? admitInputTimeoutMs() : ACTION_POLICY[action].timeoutMs;
  const prepared = await prepareAndroidAutomationHelper(device);
  try {
    const headers = await runAndroidSnapshotHelperSessionTouchCommand({
      deviceKey,
      action,
      helper: androidAutomationHelperIdentity(prepared.artifact),
      payloadBase64: encodeHelperPayload(request, timeoutMs),
      timeoutMs,
    });
    if (!headers) return undefined;
    switch (action) {
      case 'input':
        return true;
      case 'screenshot':
        return {
          png: decodeHelperPayload(headers, 'payloadBase64', false),
          displays: decodeHelperDisplays(headers),
        };
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

function decodeHelperDisplays(
  headers: Record<string, string>,
): AndroidHelperScreenshot['displays'] {
  const count = decodeHelperIndex(headers.displayCount);
  if (count === undefined) return undefined;
  const rotationIndex = decodeHelperIndex(headers.displayRotation);
  return rotationIndex === undefined ? { count } : { count, rotationIndex };
}

function decodeHelperIndex(value: string | undefined): number | undefined {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
}

/**
 * The host waits for input up to its cap, or until the request's own deadline when that is sooner.
 * A request with no room for one attempt is refused before anything is sent. The refusal is thrown
 * before the helper call's fallback on purpose: that path stops the shared session, and
 * `adb shell input` could not answer in that time either.
 */
function admitInputTimeoutMs(): number {
  const capMs = ACTION_POLICY.input.timeoutMs;
  const requestDeadlineMs = getRequestDeadlineMs(getDiagnosticsMeta().requestId);
  const timeoutMs =
    requestDeadlineMs === undefined
      ? capMs
      : Math.max(0, Math.min(capMs, requestDeadlineMs - Date.now()));
  if (timeoutMs < MIN_INPUT_ATTEMPT_MS) {
    throw new AppError(
      'COMMAND_FAILED',
      'Android input was not sent: the request has too little time left for one attempt',
      {
        reason: 'android-input-budget-exhausted',
        remainingMs: timeoutMs,
        minimumMs: MIN_INPUT_ATTEMPT_MS,
        dispatched: 'no',
      },
    );
  }
  return timeoutMs;
}

function encodeHelperPayload(
  request: AndroidAutomationRequest,
  timeoutMs: number,
): string | undefined {
  if (!('input' in request)) return undefined;
  const payload =
    request.action === 'input'
      ? { ...request.input, budgetMs: Math.max(0, timeoutMs - INPUT_ANSWER_MARGIN_MS) }
      : request.input;
  return Buffer.from(JSON.stringify(payload)).toString('base64');
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
