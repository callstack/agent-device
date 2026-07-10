import {
  resolveAndroidAdbExecutor,
  type AndroidAdbExecutor,
} from '../../platforms/android/adb-executor.ts';
import {
  isAndroidTestImeActive,
  readAndroidDefaultInputMethod,
  ANDROID_TEST_IME_SETTINGS_KEYS,
} from '../../platforms/android/ime-lifecycle.ts';
import { resolveAndroidImeHelperArtifact } from '../../platforms/android/ime-helper.ts';
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
  if (device.platform !== 'android') return;
  const adb = resolveAndroidAdbExecutor(device, androidAdbExecutor);
  if (shouldProbeMetro) {
    appendDoctorCheck(checks, await probeAndroidReverse(adb, device.id, metroPort));
  }
  appendDoctorCheck(checks, await probeAndroidTestIme(adb, device));
}

async function probeAndroidTestIme(
  adb: AndroidAdbExecutor,
  device: DeviceInfo,
): Promise<DoctorCheck> {
  try {
    const currentIme = await readAndroidDefaultInputMethod(adb);
    const helperActiveInThisProcess = isAndroidTestImeActive(device);
    const isHelperCurrentIme = currentIme === (await resolveAndroidImeHelperServiceComponent());
    if (isHelperCurrentIme && !helperActiveInThisProcess) {
      return await buildOrphanedTestImeCheck(adb, device, currentIme);
    }
    return buildActiveTestImeCheck(device, currentIme, helperActiveInThisProcess);
  } catch (error) {
    return buildTestImeProbeFailureCheck(error);
  }
}

async function resolveAndroidImeHelperServiceComponent(): Promise<string | undefined> {
  try {
    return (await resolveAndroidImeHelperArtifact()).manifest.serviceComponent;
  } catch {
    return undefined;
  }
}

// Test IME is active but no session in this process owns it: orphaned by a crashed daemon run.
async function buildOrphanedTestImeCheck(
  adb: AndroidAdbExecutor,
  device: DeviceInfo,
  currentIme: string,
): Promise<DoctorCheck> {
  const previousImeResult = await adb(
    ['shell', 'settings', 'get', 'secure', ANDROID_TEST_IME_SETTINGS_KEYS.previousIme],
    { allowFailure: true, timeoutMs: ANDROID_PROBE_TIMEOUT_MS },
  );
  const previousIme = previousImeResult.stdout.trim();
  const restoreTarget = previousIme && previousIme !== 'null' ? previousIme : undefined;
  return {
    id: 'android-test-ime',
    status: 'fail',
    summary: `Android test IME helper is the active input method on ${device.id}, but no active session owns it -- likely left over from a crashed session.`,
    hint: 'A stuck test IME leaves the real keyboard unavailable on this device until restored.',
    command: restoreTarget
      ? `adb -s ${device.id} shell ime set ${restoreTarget}`
      : `adb -s ${device.id} shell ime list -s`,
    evidence: { currentIme, previousIme: restoreTarget },
  };
}

function buildActiveTestImeCheck(
  device: DeviceInfo,
  currentIme: string,
  helperActiveInThisProcess: boolean,
): DoctorCheck {
  return {
    id: 'android-test-ime',
    status: 'pass',
    summary: helperActiveInThisProcess
      ? `Android test IME helper is active for this session on ${device.id}.`
      : `Android test IME helper is not active on ${device.id}; the device's normal IME is in use.`,
    evidence: { currentIme },
  };
}

function buildTestImeProbeFailureCheck(error: unknown): DoctorCheck {
  const normalized = normalizeError(error);
  return {
    id: 'android-test-ime',
    status: 'warn',
    summary: 'Could not inspect the Android test IME helper state.',
    hint: normalized.message,
    evidence: { code: normalized.code },
  };
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
