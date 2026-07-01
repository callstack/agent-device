import { access } from 'node:fs/promises';
import path from 'node:path';
import type { PlatformSelector } from '../../kernel/device.ts';
import { normalizeError } from '../../kernel/errors.ts';
import { runCmd, whichCmd, type ExecResult } from '../../utils/exec.ts';
import { appendDoctorCheck } from './session-doctor-output.ts';
import type { DoctorCheck } from './session-doctor-types.ts';

const TOOLCHAIN_TIMEOUT_MS = 3_000;

type SafeExecResult = ExecResult | { error: string };

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
  if (!adbAvailable) {
    return {
      id: 'toolchain',
      status: 'info',
      summary: 'Android toolchain: adb not found on PATH.',
      hint: 'Install Android platform-tools or add adb to PATH.',
      evidence: { androidHome: sdkRoot ?? null, license },
    };
  }

  const adbVersion = await safeRun('adb', ['version']);
  const versionLine = firstStdoutLine(adbVersion);
  const sdkSummary = sdkRoot ? 'ANDROID_HOME/ANDROID_SDK_ROOT set' : 'ANDROID_HOME unset';
  return {
    id: 'toolchain',
    status: versionLine && sdkRoot && license !== 'missing' ? 'pass' : 'info',
    summary: versionLine
      ? `Android toolchain: ${versionLine}; ${sdkSummary}.`
      : 'Android toolchain: adb is present but version check failed.',
    hint:
      license === 'missing'
        ? 'Accept Android SDK licenses before installing/building apps.'
        : undefined,
    command: license === 'missing' ? 'sdkmanager --licenses' : undefined,
    evidence: { androidHome: sdkRoot ?? null, license, adbVersion },
  };
}

async function appleToolchainCheck(): Promise<DoctorCheck> {
  const xcodeSelectAvailable = await whichCmd('xcode-select');
  const xcodebuildAvailable = await whichCmd('xcodebuild');
  if (!xcodeSelectAvailable && !xcodebuildAvailable) {
    return {
      id: 'toolchain',
      status: 'info',
      summary: 'Apple toolchain: xcode-select and xcodebuild not found on PATH.',
      hint: 'Install Xcode and select it with xcode-select.',
      evidence: { xcodeSelect: false, xcodebuild: false },
    };
  }

  const selectedXcode = xcodeSelectAvailable ? await safeRun('xcode-select', ['-p']) : undefined;
  const xcodeVersion = xcodebuildAvailable ? await safeRun('xcodebuild', ['-version']) : undefined;
  const firstLaunch = xcodebuildAvailable
    ? await safeRun('xcodebuild', ['-checkFirstLaunchStatus'])
    : undefined;
  const versionLine = firstStdoutLine(xcodeVersion);
  const selectedPath = firstStdoutLine(selectedXcode);
  const firstLaunchOk = isSuccessful(firstLaunch);

  return {
    id: 'toolchain',
    status: selectedPath && versionLine && firstLaunchOk ? 'pass' : 'info',
    summary:
      selectedPath && versionLine
        ? `Apple toolchain: ${versionLine}; xcode-select ${selectedPath}.`
        : 'Apple toolchain: Xcode selection or version check failed.',
    hint: firstLaunchOk
      ? undefined
      : 'Complete Xcode first launch/license setup before building apps.',
    command: firstLaunchOk ? undefined : 'sudo xcodebuild -runFirstLaunch',
    evidence: { selectedXcode, xcodeVersion, firstLaunch },
  };
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
