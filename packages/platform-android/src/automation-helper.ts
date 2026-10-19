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

const ACTION_POLICY = {
  input: { mutation: true, timeoutMs: 30_000 },
  screenshot: { mutation: false, timeoutMs: 30_000 },
  focus: { mutation: false, timeoutMs: 2_000 },
} as const;

/** Reuses the session's automation context without starting instrumentation for sessionless input. */
export async function runAndroidAutomationHelper(
  device: DeviceInfo,
  action: keyof typeof ACTION_POLICY,
  input?: AndroidHelperInput,
): Promise<Record<string, string> | undefined> {
  const deviceKey = getAndroidSnapshotHelperSessionDeviceKey(device);
  if (!(await getLiveAndroidSnapshotHelperSession(deviceKey))?.commands.has(action))
    return undefined;
  const prepared = await prepareAndroidAutomationHelper(device);
  try {
    return await runAndroidSnapshotHelperSessionTouchCommand({
      deviceKey,
      action,
      helper: androidAutomationHelperIdentity(prepared.artifact),
      payloadBase64: input ? Buffer.from(JSON.stringify(input)).toString('base64') : undefined,
      timeoutMs: ACTION_POLICY[action].timeoutMs,
    });
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
