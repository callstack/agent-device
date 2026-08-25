import { access } from 'node:fs/promises';
import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { normalizeError } from '@agent-device/kernel/errors';
import type { DoctorCheck } from '@agent-device/contracts/observability';
import type { HostDiagnosticsContext } from '@agent-device/contracts/host-diagnostics';
import { commandFirstLine } from '../toolchain-probe.ts';
import { resolveAndroidAdbExecutor, type AndroidAdbExecutor } from './adb-executor.ts';
import {
  isAndroidTestImeActive,
  readAndroidDefaultInputMethod,
  ANDROID_TEST_IME_SETTINGS_KEYS,
} from './ime-lifecycle.ts';
import { resolveAndroidImeHelperArtifact } from './ime-helper.ts';

const ANDROID_PROBE_TIMEOUT_MS = 2000;

type AndroidLicenseState = 'accepted' | 'missing' | 'unknown';
type AndroidToolchainProbe = {
  license: AndroidLicenseState;
  sdkRoot: string | undefined;
  versionLine: string | undefined;
};

export async function androidToolchainCheck(): Promise<DoctorCheck> {
  const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const license = await androidLicenseState(sdkRoot);
  const versionLine = await commandFirstLine('adb', ['version']);
  if (!versionLine) return missingAndroidAdbCheck(sdkRoot, license);

  return androidAdbCheck({
    license,
    sdkRoot,
    versionLine,
  });
}

/** The android family's device diagnostics: Metro reverse mapping plus orphaned test-IME. */
export async function androidDeviceChecks(
  device: DeviceInfo,
  context: HostDiagnosticsContext,
): Promise<readonly DoctorCheck[]> {
  if (device.platform !== 'android') return [];
  // The provider-scope override travels opaquely through the neutral context; this family is
  // the one owner that narrows it back to its own executor type.
  const adb = resolveAndroidAdbExecutor(
    device,
    context.transportOverrides.androidAdb as AndroidAdbExecutor | undefined,
  );
  const checks: DoctorCheck[] = [];
  if (context.shouldProbeMetro) {
    checks.push(await probeAndroidReverse(adb, device.id, context.metroPort));
  }
  checks.push(await probeAndroidTestIme(adb, device));
  return checks;
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

function androidAdbCheck(probe: AndroidToolchainProbe): DoctorCheck {
  return {
    id: 'toolchain',
    status: androidToolchainStatus(probe),
    summary: probe.versionLine
      ? `Android toolchain: ${probe.versionLine}; ${androidSdkSummary(probe.sdkRoot)}.`
      : 'Android toolchain: adb is present but version check failed.',
    hint:
      probe.license === 'missing'
        ? 'Accept Android SDK licenses before installing/building apps.'
        : undefined,
    command: probe.license === 'missing' ? 'sdkmanager --licenses' : undefined,
    evidence: {
      adbVersion: probe.versionLine ?? null,
      androidHome: probe.sdkRoot ?? null,
      license: probe.license,
    },
  };
}

function androidToolchainStatus(probe: AndroidToolchainProbe): DoctorCheck['status'] {
  return probe.versionLine && probe.sdkRoot && probe.license !== 'missing' ? 'pass' : 'info';
}

function androidSdkSummary(sdkRoot: string | undefined): string {
  return sdkRoot ? 'ANDROID_HOME/ANDROID_SDK_ROOT set' : 'ANDROID_HOME unset';
}

function missingAndroidAdbCheck(
  sdkRoot: string | undefined,
  license: AndroidLicenseState,
): DoctorCheck {
  return {
    id: 'toolchain',
    status: 'info',
    summary: 'Android toolchain: adb not found on PATH.',
    hint: 'Install Android platform-tools or add adb to PATH.',
    evidence: { androidHome: sdkRoot ?? null, license },
  };
}

async function androidLicenseState(sdkRoot: string | undefined): Promise<AndroidLicenseState> {
  if (!sdkRoot) return 'unknown';
  try {
    await access(path.join(sdkRoot, 'licenses', 'android-sdk-license'));
    return 'accepted';
  } catch {
    return 'missing';
  }
}
