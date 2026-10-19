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

/** Reuses the session's automation context without starting instrumentation for sessionless input. */
export async function runAndroidAutomationHelper(
  device: DeviceInfo,
  action: 'input' | 'screenshot' | 'focus',
  input?: AndroidHelperInput,
): Promise<Record<string, string> | undefined> {
  const deviceKey = getAndroidSnapshotHelperSessionDeviceKey(device);
  if (!getLiveAndroidSnapshotHelperSession(deviceKey)?.commands.has(action)) return undefined;
  const prepared = await prepareAndroidAutomationHelper(device);
  try {
    return await runAndroidSnapshotHelperSessionTouchCommand({
      deviceKey,
      action,
      helper: androidAutomationHelperIdentity(prepared.artifact),
      payloadBase64: input ? Buffer.from(JSON.stringify(input)).toString('base64') : undefined,
      timeoutMs: action === 'focus' ? 2_000 : 30_000,
    });
  } catch (error) {
    if (action !== 'focus') throw error;
    await stopAndroidSnapshotHelperSession(deviceKey);
    emitDiagnostic({
      level: 'warn',
      phase: 'android_helper_focus_fallback',
      data: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return undefined;
  }
}
