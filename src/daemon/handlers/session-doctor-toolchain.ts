import { access } from 'node:fs/promises';
import path from 'node:path';
import type { PlatformSelector } from '../../kernel/device.ts';
import { runCmd } from '../../utils/exec.ts';
import { appendDoctorCheck } from './session-doctor-output.ts';
import type { DoctorCheck } from './session-doctor-types.ts';

const TOOLCHAIN_TIMEOUT_MS = 3_000;
type AndroidLicenseState = 'accepted' | 'missing' | 'unknown';
type AndroidToolchainProbe = {
  license: AndroidLicenseState;
  sdkRoot: string | undefined;
  versionLine: string | undefined;
};
type AppleToolchainProbe = {
  selectedPath: string | undefined;
  versionLine: string | undefined;
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

async function appleToolchainCheck(): Promise<DoctorCheck> {
  const versionLine = await commandFirstLine('xcodebuild', ['-version']);
  if (!versionLine) return missingAppleToolchainCheck();

  return appleProbeCheck({
    selectedPath: await commandFirstLine('xcode-select', ['-p']),
    versionLine,
  });
}

function appleProbeCheck(probe: AppleToolchainProbe): DoctorCheck {
  return {
    id: 'toolchain',
    status: appleToolchainStatus(probe),
    summary: appleToolchainSummary(probe),
    evidence: {
      selectedPath: probe.selectedPath ?? null,
      xcodeVersion: probe.versionLine ?? null,
    },
  };
}

function appleToolchainStatus(probe: AppleToolchainProbe): DoctorCheck['status'] {
  return probe.versionLine ? 'pass' : 'info';
}

function appleToolchainSummary(probe: AppleToolchainProbe): string {
  if (!probe.versionLine) return 'Apple toolchain: xcodebuild version check failed.';
  if (!probe.selectedPath) {
    return `Apple toolchain: ${probe.versionLine}; xcode-select path unavailable.`;
  }
  return `Apple toolchain: ${probe.versionLine}; xcode-select ${probe.selectedPath}.`;
}

function missingAppleToolchainCheck(): DoctorCheck {
  return {
    id: 'toolchain',
    status: 'info',
    summary: 'Apple toolchain: xcodebuild version check failed.',
    hint: 'Install/select Xcode and complete first launch/license setup if xcodebuild reports it.',
    command: 'xcodebuild -version',
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

async function commandFirstLine(cmd: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await runCmd(cmd, args, { allowFailure: true, timeoutMs: TOOLCHAIN_TIMEOUT_MS });
    if (result.exitCode !== 0) return undefined;
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}
