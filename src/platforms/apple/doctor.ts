import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import type { DoctorCheck } from '@agent-device/contracts/observability';
import type { HostDiagnosticsContext } from '@agent-device/contracts/host-diagnostics';
import { commandFirstLine } from '../toolchain-probe.ts';
import { hasCachedAppleRunnerArtifact, prewarmAppleRunnerCache } from './core/runner-client.ts';

type AppleToolchainProbe = {
  selectedPath: string | undefined;
  versionLine: string | undefined;
};

export async function appleToolchainCheck(): Promise<DoctorCheck> {
  const versionLine = await commandFirstLine('xcodebuild', ['-version']);
  if (!versionLine) return missingAppleToolchainCheck();

  return appleProbeCheck({
    selectedPath: await commandFirstLine('xcode-select', ['-p']),
    versionLine,
  });
}

/**
 * Doctor doubles as the fresh-machine warmup: when an iOS simulator is in scope and the runner
 * artifact is not built yet, kick the build in the background so the first `open` skips the
 * ~10s xcodebuild build. The check line makes the warmup visible either way. The warmup drives
 * local xcodebuild: skip on non-macOS hosts and for provider-backed devices, whose runner lives
 * with the remote daemon.
 */
export async function appleRunnerWarmupCheck(
  device: DeviceInfo,
  context: HostDiagnosticsContext,
): Promise<DoctorCheck | undefined> {
  if (!isIosFamily(device) || device.kind !== 'simulator') return undefined;
  if (process.platform !== 'darwin' || context.isProviderDevice(device)) return undefined;
  context.emitProgress(`Checking iOS runner build cache (${device.name})...`);
  if (await hasCachedAppleRunnerArtifact(device)) {
    return {
      id: 'ios-runner-cache',
      status: 'pass',
      summary: 'iOS runner artifact cached; first open skips the runner build',
    };
  }
  void prewarmAppleRunnerCache(device, {});
  context.emitProgress(`Warming iOS runner build cache in the background (${device.name})...`);
  return {
    id: 'ios-runner-cache',
    status: 'pass',
    summary:
      'iOS runner build started in the background; the first open gets faster once it completes',
    hint: 'Run `agent-device prepare ios-runner` to wait for a fully warmed runner instead.',
  };
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
