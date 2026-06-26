import {
  getAndroidAppState,
  type AndroidForegroundApp,
} from '../../platforms/android/app-lifecycle.ts';
import {
  resolveAndroidAdbExecutor,
  type AndroidAdbExecutor,
} from '../../platforms/android/adb-executor.ts';
import type { DeviceInfo } from '../../utils/device.ts';
import { normalizeError } from '../../utils/errors.ts';
import type { SessionState } from '../types.ts';
import { appendDoctorCheck } from './session-doctor-output.ts';
import type { DoctorCheck } from './session-doctor-types.ts';

const ANDROID_PROBE_TIMEOUT_MS = 2000;
const ANDROID_LAUNCHER_PACKAGES = new Set([
  'com.android.launcher',
  'com.android.launcher3',
  'com.google.android.apps.nexuslauncher',
]);

export async function appendAndroidChecks(
  checks: DoctorCheck[],
  params: {
    device: DeviceInfo;
    session: SessionState | undefined;
    targetApp?: string;
    metroPort: number;
    shouldProbeMetro: boolean;
    androidAdbExecutor?: AndroidAdbExecutor;
  },
): Promise<void> {
  const { device, session, targetApp, metroPort, shouldProbeMetro, androidAdbExecutor } = params;
  if (device.platform !== 'android') return;
  const adb = resolveAndroidAdbExecutor(device, androidAdbExecutor);
  const expectedPackage = targetApp ?? session?.appBundleId;

  if (expectedPackage) {
    try {
      const state = await getAndroidAppState(device);
      appendDoctorCheck(checks, androidForegroundCheck(state, expectedPackage));
    } catch (error) {
      const normalized = normalizeError(error);
      appendDoctorCheck(checks, {
        id: 'android-foreground',
        status: 'warn',
        summary: 'Could not read Android foreground package.',
        hint: normalized.message,
        evidence: { code: normalized.code },
      });
    }
  }

  if (shouldProbeMetro) {
    appendDoctorCheck(checks, await probeAndroidReverse(adb, device.id, metroPort));
  }
  appendDoctorCheck(checks, await probeAndroidAnimations(adb));
}

function androidForegroundCheck(
  state: AndroidForegroundApp,
  expectedPackage: string | undefined,
): DoctorCheck {
  const foregroundPackage = state.package;
  const onLauncher = isAndroidLauncherPackage(foregroundPackage);
  const mismatch = hasAndroidForegroundMismatch(foregroundPackage, expectedPackage);
  return {
    id: 'android-foreground',
    status: onLauncher || mismatch ? 'warn' : 'pass',
    summary: androidForegroundSummary(foregroundPackage, expectedPackage, onLauncher, mismatch),
    command:
      expectedPackage && (onLauncher || mismatch)
        ? `agent-device open ${expectedPackage} --platform android`
        : undefined,
    evidence: state as Record<string, unknown>,
  };
}

function isAndroidLauncherPackage(packageName: string | undefined): boolean {
  return packageName ? ANDROID_LAUNCHER_PACKAGES.has(packageName) : false;
}

function hasAndroidForegroundMismatch(
  foregroundPackage: string | undefined,
  expectedPackage: string | undefined,
): boolean {
  return expectedPackage !== undefined && foregroundPackage !== expectedPackage;
}

function androidForegroundSummary(
  foregroundPackage: string | undefined,
  expectedPackage: string | undefined,
  onLauncher: boolean,
  mismatch: boolean,
): string {
  const actual = foregroundPackage ?? 'unknown';
  if (onLauncher) return 'Android is on the launcher, not the target app.';
  if (mismatch) return `Android foreground package is ${actual}, expected ${expectedPackage}.`;
  return `Android foreground package is ${actual}.`;
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

async function probeAndroidAnimations(adb: AndroidAdbExecutor): Promise<DoctorCheck> {
  const keys = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'];
  try {
    const values: Record<string, string> = {};
    for (const key of keys) {
      const result = await adb(['shell', 'settings', 'get', 'global', key], {
        allowFailure: true,
        timeoutMs: ANDROID_PROBE_TIMEOUT_MS,
      });
      values[key] = result.stdout.trim();
    }
    const enabled = Object.values(values).some((value) => value !== '0' && value !== '0.0');
    return {
      id: 'android-animations',
      status: enabled ? 'warn' : 'pass',
      summary: enabled
        ? 'Android animations are enabled and can slow or flake automation.'
        : 'Android animations are disabled.',
      hint: enabled ? 'Disable animations in emulator settings before long QA runs.' : undefined,
      evidence: values,
    };
  } catch (error) {
    const normalized = normalizeError(error);
    return {
      id: 'android-animations',
      status: 'warn',
      summary: 'Could not read Android animation settings.',
      hint: normalized.message,
      evidence: { code: normalized.code },
    };
  }
}
