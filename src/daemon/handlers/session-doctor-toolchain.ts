import { access } from 'node:fs/promises';
import path from 'node:path';
import type { DeviceInfo, PlatformSelector } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { runCmd } from '../../utils/exec.ts';
import { appendDoctorCheck } from './session-doctor-output.ts';
import type { DoctorCheck } from '@agent-device/contracts/observability';
import {
  listLocalDeviceInventory,
  shouldPropagateDeviceInventoryProbeError,
} from '../../core/device-inventory-context.ts';

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
type VegaInventoryProbe = Readonly<{
  devices: readonly DeviceInfo[];
  listedSerials: readonly string[];
}>;

export async function appendToolchainChecks(
  checks: DoctorCheck[],
  platform: PlatformSelector | undefined,
): Promise<void> {
  if (platform === 'android') {
    appendDoctorCheck(checks, await androidToolchainCheck());
    return;
  }
  if (platform === 'vega') {
    appendDoctorCheck(checks, await vegaToolchainCheck());
    return;
  }
  if (platform === 'harmonyos') {
    appendDoctorCheck(checks, await harmonyToolchainCheck());
    return;
  }
  if (platform === 'ios' || platform === 'macos' || platform === 'apple') {
    appendDoctorCheck(checks, await appleToolchainCheck());
  }
}

async function harmonyToolchainCheck(): Promise<DoctorCheck> {
  const versionLine = await commandFirstLine('hdc', ['-v']);
  if (!versionLine) {
    return {
      id: 'toolchain',
      status: 'info',
      summary: 'HarmonyOS toolchain: hdc not found or version check failed.',
      hint: 'Install HarmonyOS Command Line Tools, then add sdk/default/openharmony/toolchains to PATH or set HDC_SDK_PATH.',
      command: 'hdc -v',
      evidence: { hdcVersion: null },
    };
  }
  return {
    id: 'toolchain',
    status: 'pass',
    summary: `HarmonyOS toolchain: ${versionLine}.`,
    evidence: { hdcVersion: versionLine },
  };
}

async function vegaToolchainCheck(): Promise<DoctorCheck> {
  const { resolveVegaToolProvider } = await import('../../platforms/vega/tool-provider.ts');
  const provider = resolveVegaToolProvider();
  if (!(await provider.isAvailable())) {
    return {
      id: 'toolchain',
      status: 'info',
      summary: 'Vega toolchain: Vega CLI not found.',
      hint: 'Install Vega Developer Tools or ensure ~/vega/bin/vega is executable.',
      command: 'vega --version',
    };
  }

  const version = await provider.version({
    allowFailure: true,
    timeoutMs: TOOLCHAIN_TIMEOUT_MS,
  });
  const inventory = await readLocalVegaInventory();
  const versionLine = firstOutputLine(version.stdout);
  const hasRunningVvd = inventory.devices.some(
    (device) =>
      device.platform === 'vega' &&
      device.kind === 'emulator' &&
      device.target === 'tv' &&
      device.booted === true,
  );

  return {
    id: 'toolchain',
    status: version.exitCode === 0 ? 'pass' : 'info',
    summary: versionLine
      ? `Vega toolchain: ${versionLine}; ${hasRunningVvd ? 'VVD running' : 'no running VVD'}.`
      : 'Vega toolchain: CLI found but version check failed.',
    hint: hasRunningVvd ? undefined : 'Start the Vega Virtual Device and retry doctor.',
    evidence: {
      vegaVersion: versionLine ?? null,
      deviceList: vegaInventoryEvidence(inventory),
    },
  };
}

async function readLocalVegaInventory(): Promise<VegaInventoryProbe> {
  try {
    return {
      devices: await listLocalDeviceInventory({ platform: 'vega', target: 'tv' }),
      listedSerials: [],
    };
  } catch (error) {
    if (shouldPropagateDeviceInventoryProbeError(error)) throw error;
    return { devices: [], listedSerials: listedVegaSerials(error) };
  }
}

function listedVegaSerials(error: unknown): readonly string[] {
  if (!(error instanceof AppError) || error.code !== 'DEVICE_NOT_FOUND') return [];
  const listed = error.details?.listedSerials;
  return isStringArray(listed) ? listed : [];
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function vegaInventoryEvidence(inventory: VegaInventoryProbe): string | null {
  const serials =
    inventory.devices.length > 0
      ? inventory.devices.map((device) => device.id)
      : inventory.listedSerials;
  return serials.join(', ') || null;
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
    return firstOutputLine(result.stdout);
  } catch {
    return undefined;
  }
}

function firstOutputLine(output: string): string | undefined {
  return output
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
}
