import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { normalizeError } from '@agent-device/kernel/errors';
import type { DoctorCheck } from '@agent-device/contracts/observability';
import type { HostDiagnosticsContext } from '@agent-device/contracts/host-diagnostics';
import { commandOutput, firstOutputLine } from '@agent-device/provision-kit/toolchain-probe';
import { resolveAndroidAdbExecutor, runAdbShell, type AndroidAdbExecutor } from './adb-executor.ts';
import {
  isAndroidTestImeActive,
  readAndroidDefaultInputMethod,
  ANDROID_TEST_IME_SETTINGS_KEYS,
} from './ime-lifecycle.ts';
import { resolveAndroidImeHelperArtifact } from './ime-helper.ts';
import {
  requireAndroidAdbHost,
  type AndroidAdbEnvironment,
  type AndroidAdbFileHost,
} from './adb-host.ts';

const ANDROID_PROBE_TIMEOUT_MS = 2000;
const WINDOWS_ADB_ON_POSIX_HOST_REASON = 'android_adb_windows_binary_on_posix_host';

type AndroidLicenseState = 'accepted' | 'missing' | 'unknown';
type AndroidToolchainProbe = {
  license: AndroidLicenseState;
  sdkRoot: string | undefined;
  versionLine: string | undefined;
};

export async function androidToolchainCheck(
  environment: AndroidAdbEnvironment,
  hostPlatform: NodeJS.Platform,
  files: Pick<AndroidAdbFileHost, 'access'> = requireAndroidAdbHost().files,
): Promise<DoctorCheck> {
  const sdkRoot = environment.ANDROID_HOME || environment.ANDROID_SDK_ROOT;
  const license = await androidLicenseState(sdkRoot, files);
  const versionOutput = await commandOutput('adb', ['version']);
  const versionLine = versionOutput === undefined ? undefined : firstOutputLine(versionOutput);
  if (!versionOutput || !versionLine) return missingAndroidAdbCheck(sdkRoot, license);
  const windowsAdb = hostPlatform === 'win32' ? undefined : detectWindowsAdb(versionOutput);
  if (windowsAdb) {
    return windowsAdbOnPosixHostCheck({ windowsAdb, sdkRoot, versionLine });
  }

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
  const previousImeResult = await runAdbShell(
    adb,
    ['settings', 'get', 'secure', ANDROID_TEST_IME_SETTINGS_KEYS.previousIme],
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

/** The binary path adb reports for itself on its `Installed as` version line. */
function androidAdbInstallPath(versionOutput: string): string | undefined {
  return /^Installed as (.+)$/m.exec(versionOutput)?.[1]?.trim();
}

/** A drive-letter or UNC path, which only a Windows binary reports. */
function isWindowsHostPath(candidate: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(candidate);
}

/** Banner line naming the OS the running adb was built for; a native host binary never names Windows. */
function reportsWindowsRuntime(versionOutput: string): boolean {
  return /^Running on Windows\b/m.test(versionOutput);
}

/** adb's self-report that it is a Windows binary, plus the signal that revealed it. */
type WindowsAdbReport = Readonly<{
  detectedVia: 'installed-as-path' | 'running-on-line';
  adbPath: string | undefined;
}>;

function detectWindowsAdb(versionOutput: string): WindowsAdbReport | undefined {
  const installPath = androidAdbInstallPath(versionOutput);
  if (installPath && isWindowsHostPath(installPath)) {
    return { detectedVia: 'installed-as-path', adbPath: installPath };
  }
  if (reportsWindowsRuntime(versionOutput)) {
    return { detectedVia: 'running-on-line', adbPath: undefined };
  }
  return undefined;
}

/**
 * A Windows adb.exe reached from a POSIX host through WSL interop or Wine answers
 * `adb version`, but it resolves every host path it is handed as a Windows path, so pulls, pushes,
 * and installs miss the host's files. Older and third-party adb builds omit the `Installed as`
 * banner, so the `Running on Windows` line is the fallback signal for them.
 */
function windowsAdbOnPosixHostCheck(
  probe: Readonly<{
    windowsAdb: WindowsAdbReport;
    sdkRoot: string | undefined;
    versionLine: string;
  }>,
): DoctorCheck {
  const { adbPath, detectedVia } = probe.windowsAdb;
  return {
    id: 'toolchain',
    status: 'fail',
    summary: `Android toolchain: adb on PATH${adbPath ? ` (${adbPath})` : ''} is a Windows binary, which cannot use this host's file paths.`,
    hint: "adb must be a native binary for this host: install this host's Android platform-tools, put them first on PATH, and point ANDROID_HOME at an SDK on this host's filesystem. Under WSL that means a Linux SDK, not one under /mnt/<drive>.",
    evidence: {
      reason: WINDOWS_ADB_ON_POSIX_HOST_REASON,
      detectedVia,
      adbPath: adbPath ?? null,
      adbVersion: probe.versionLine,
      androidHome: probe.sdkRoot ?? null,
    },
  };
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

async function androidLicenseState(
  sdkRoot: string | undefined,
  files: Pick<AndroidAdbFileHost, 'access'>,
): Promise<AndroidLicenseState> {
  if (!sdkRoot) return 'unknown';
  try {
    await files.access(path.join(sdkRoot, 'licenses', 'android-sdk-license'));
    return 'accepted';
  } catch {
    return 'missing';
  }
}
