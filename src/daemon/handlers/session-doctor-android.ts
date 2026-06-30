import {
  resolveAndroidAdbExecutor,
  type AndroidAdbExecutor,
} from '../../platforms/android/adb-executor.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import { normalizeError } from '../../kernel/errors.ts';
import { appendDoctorCheck } from './session-doctor-output.ts';
import type { DoctorCheck } from './session-doctor-types.ts';

const ANDROID_PROBE_TIMEOUT_MS = 2000;

export async function appendAndroidChecks(
  checks: DoctorCheck[],
  params: {
    device: DeviceInfo;
    metroPort: number;
    shouldProbeMetro: boolean;
    androidAdbExecutor?: AndroidAdbExecutor;
  },
): Promise<void> {
  const { device, metroPort, shouldProbeMetro, androidAdbExecutor } = params;
  if (device.platform !== 'android' || !shouldProbeMetro) return;
  const adb = resolveAndroidAdbExecutor(device, androidAdbExecutor);
  appendDoctorCheck(checks, await probeAndroidReverse(adb, device.id, metroPort));
}

async function probeAndroidReverse(
  adb: AndroidAdbExecutor,
  serial: string,
  metroPort: number,
): Promise<DoctorCheck> {
  try {
    const result = await adb(['reverse', '--list'], {
      allowFailure: true,
      timeoutMs: ANDROID_PROBE_TIMEOUT_MS,
    });
    const expected = `tcp:${metroPort} tcp:${metroPort}`;
    const hasReverse = result.stdout.includes(expected);
    return {
      id: 'android-reverse',
      status: hasReverse ? 'pass' : 'warn',
      summary: hasReverse
        ? `Android adb reverse exists for Metro port ${metroPort}.`
        : `Android adb reverse is missing for Metro port ${metroPort}.`,
      command: hasReverse
        ? undefined
        : `adb -s ${serial} reverse tcp:${metroPort} tcp:${metroPort}`,
      evidence: { stdout: result.stdout.trim() },
    };
  } catch (error) {
    const normalized = normalizeError(error);
    return {
      id: 'android-reverse',
      status: 'warn',
      summary: 'Could not inspect Android adb reverse mappings.',
      hint: normalized.message,
      evidence: { code: normalized.code },
    };
  }
}
