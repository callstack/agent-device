import { access } from 'node:fs/promises';
import path from 'node:path';
import type { PlatformSelector } from '../../kernel/device.ts';
import { normalizeError } from '../../kernel/errors.ts';
import { runCmd, whichCmd, type ExecResult } from '../../utils/exec.ts';
import { appendDoctorCheck } from './session-doctor-output.ts';
import type { DoctorCheck } from './session-doctor-types.ts';

const TOOLCHAIN_TIMEOUT_MS = 3_000;

type SafeExecResult = ExecResult | { error: string };
type AndroidToolchainProbe = {
  adbVersion: SafeExecResult;
  license: 'accepted' | 'missing' | 'unknown';
  sdkRoot: string | undefined;
  versionLine: string | undefined;
};
type AppleToolchainProbe = {
  firstLaunch: SafeExecResult | undefined;
  firstLaunchOk: boolean;
  selectedPath: string | undefined;
  selectedXcode: SafeExecResult | undefined;
  versionLine: string | undefined;
  xcodeVersion: SafeExecResult | undefined;
};

export async function appendToolchainChecks(
  checks: DoctorCheck[],
  platform: PlatformSelector | undefined,
): Promise<void> {
  if (platform === 'android') {
    appendDoctorCheck(checks, await androidToolchainCheck());
    return;
  }
  if (platform === 'ios' || platform === 'macos' || platform === 'apple') {
    appendDoctorCheck(checks, await appleToolchainCheck());
  }
}

async function androidToolchainCheck(): Promise<DoctorCheck> {
  const adbAvailable = await whichCmd('adb');
  const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const license = await androidLicenseState(sdkRoot);
  if (!adbAvailable) return missingAndroidAdbCheck(sdkRoot, license);

  const adbVersion = await safeRun('adb', ['version']);
  const versionLine = firstStdoutLine(adbVersion);
  return androidAdbCheck({ adbVersion, license, sdkRoot, versionLine });
}

function missingAndroidAdbCheck(
  sdkRoot: string | undefined,
  license: 'accepted' | 'missing' | 'unknown',
): DoctorCheck {
  return {
    id: 'toolchain',
    status: 'info',
    summary: 'Android toolchain: adb not found on PATH.',
    hint: 'Install Android platform-tools or add adb to PATH.',
    evidence: { androidHome: sdkRoot ?? null, license },
  };
}

function androidAdbCheck(probe: AndroidToolchainProbe): DoctorCheck {
  const sdkSummary = probe.sdkRoot ? 'ANDROID_HOME/ANDROID_SDK_ROOT set' : 'ANDROID_HOME unset';
  return {
    id: 'toolchain',
    status: androidToolchainStatus(probe),
    summary: probe.versionLine
      ? `Android toolchain: ${probe.versionLine}; ${sdkSummary}.`
      : 'Android toolchain: adb is present but version check failed.',
    hint:
      probe.license === 'missing'
        ? 'Accept Android SDK licenses before installing/building apps.'
        : undefined,
    command: probe.license === 'missing' ? 'sdkmanager --licenses' : undefined,
    evidence: {
      adbVersion: probe.adbVersion,
      androidHome: probe.sdkRoot ?? null,
      license: probe.license,
    },
  };
}

function androidToolchainStatus(probe: AndroidToolchainProbe): DoctorCheck['status'] {
  return probe.versionLine && probe.sdkRoot && probe.license !== 'missing' ? 'pass' : 'info';
}

async function appleToolchainCheck(): Promise<DoctorCheck> {
  const xcodeSelectAvailable = await whichCmd('xcode-select');
  const xcodebuildAvailable = await whichCmd('xcodebuild');
  if (!xcodeSelectAvailable && !xcodebuildAvailable) return missingAppleToolchainCheck();

  const selectedXcode = xcodeSelectAvailable ? await safeRun('xcode-select', ['-p']) : undefined;
  const xcodeVersion = xcodebuildAvailable ? await safeRun('xcodebuild', ['-version']) : undefined;
  const firstLaunch = xcodebuildAvailable
    ? await safeRun('xcodebuild', ['-checkFirstLaunchStatus'])
    : undefined;
  const versionLine = firstStdoutLine(xcodeVersion);
  const selectedPath = firstStdoutLine(selectedXcode);
  const firstLaunchOk = isSuccessful(firstLaunch);
  return appleProbeCheck({
    firstLaunch,
    firstLaunchOk,
    selectedPath,
    selectedXcode,
    versionLine,
    xcodeVersion,
  });
}

function missingAppleToolchainCheck(): DoctorCheck {
  return {
    id: 'toolchain',
    status: 'info',
    summary: 'Apple toolchain: xcode-select and xcodebuild not found on PATH.',
    hint: 'Install Xcode and select it with xcode-select.',
    evidence: { xcodeSelect: false, xcodebuild: false },
  };
}

function appleProbeCheck(probe: AppleToolchainProbe): DoctorCheck {
  return {
    id: 'toolchain',
    status: appleToolchainStatus(probe),
    summary: appleToolchainSummary(probe),
    hint: probe.firstLaunchOk
      ? undefined
      : 'Complete Xcode first launch/license setup before building apps.',
    command: probe.firstLaunchOk ? undefined : 'sudo xcodebuild -runFirstLaunch',
    evidence: {
      firstLaunch: probe.firstLaunch,
      selectedXcode: probe.selectedXcode,
      xcodeVersion: probe.xcodeVersion,
    },
  };
}

function appleToolchainStatus(probe: AppleToolchainProbe): DoctorCheck['status'] {
  return probe.selectedPath && probe.versionLine && probe.firstLaunchOk ? 'pass' : 'info';
}

function appleToolchainSummary(probe: AppleToolchainProbe): string {
  if (!probe.selectedPath || !probe.versionLine) {
    return 'Apple toolchain: Xcode selection or version check failed.';
  }
  return `Apple toolchain: ${probe.versionLine}; xcode-select ${probe.selectedPath}.`;
}

async function androidLicenseState(
  sdkRoot: string | undefined,
): Promise<'accepted' | 'missing' | 'unknown'> {
  if (!sdkRoot) return 'unknown';
  try {
    await access(path.join(sdkRoot, 'licenses', 'android-sdk-license'));
    return 'accepted';
  } catch {
    return 'missing';
  }
}

async function safeRun(cmd: string, args: string[]): Promise<SafeExecResult> {
  try {
    return await runCmd(cmd, args, { allowFailure: true, timeoutMs: TOOLCHAIN_TIMEOUT_MS });
  } catch (error) {
    return { error: normalizeError(error).message };
  }
}

function firstStdoutLine(result: SafeExecResult | undefined): string | undefined {
  if (!result || 'error' in result || result.exitCode !== 0) return undefined;
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
}

function isSuccessful(result: SafeExecResult | undefined): boolean {
  return Boolean(result && !('error' in result) && result.exitCode === 0);
}
