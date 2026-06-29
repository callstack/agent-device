import { AppError } from '../../kernel/errors.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import { buildSimctlArgsForDevice } from './simctl.ts';
import { runAppleToolCommand, runXcrun } from './tool-provider.ts';

export type LaunchFailureReason =
  | 'ARCH_MISMATCH'
  | 'APP_NOT_INSTALLED'
  | 'PERSISTENT_LAUNCH_FAIL'
  | 'UNKNOWN';

type LaunchProbeResult = {
  installed: boolean;
  simulatorCompatible?: boolean;
};

export function isSimulatorLaunchFBSError(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  if (error.code !== 'COMMAND_FAILED') return false;

  const details = (error.details ?? {}) as { exitCode?: number; stderr?: unknown };
  if (details.exitCode !== 4) return false;
  const stderr = String(details.stderr ?? '').toLowerCase();

  return (
    stderr.includes('fbsopenapplicationserviceerrordomain') &&
    stderr.includes('the request to open')
  );
}

export async function probeSimulatorLaunchContext(
  device: DeviceInfo,
  bundleId: string,
): Promise<LaunchProbeResult> {
  const containerResult = await runXcrun(
    buildSimctlArgsForDevice(device, ['get_app_container', device.id, bundleId]),
    { allowFailure: true },
  );

  if (containerResult.exitCode !== 0) {
    return { installed: false };
  }

  const containerPath = containerResult.stdout.trim();
  if (!containerPath) {
    return { installed: false };
  }

  // Read the Info.plist to find the executable name
  const plistResult = await runAppleToolCommand(
    'plutil',
    ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', `${containerPath}/Info.plist`],
    { allowFailure: true },
  );

  if (plistResult.exitCode !== 0 || !plistResult.stdout.trim()) {
    return { installed: true };
  }

  const binaryName = plistResult.stdout.trim();
  const binaryPath = `${containerPath}/${binaryName}`;

  // Use otool to inspect LC_BUILD_VERSION for the platform marker.
  // This is reliable on both Intel and Apple Silicon, where `file` output
  // looks identical for device and simulator arm64 binaries.
  const otoolResult = await runAppleToolCommand('otool', ['-l', binaryPath], {
    allowFailure: true,
  });
  if (otoolResult.exitCode !== 0) {
    return { installed: true };
  }

  const otoolOutput = otoolResult.stdout.toLowerCase();
  const isSimulatorBinary =
    otoolOutput.includes('iossimulator') || otoolOutput.includes('platform 7');

  return { installed: true, simulatorCompatible: isSimulatorBinary };
}

export function classifyLaunchFailure(probe: LaunchProbeResult): LaunchFailureReason {
  if (!probe.installed) return 'APP_NOT_INSTALLED';
  if (probe.simulatorCompatible === false) return 'ARCH_MISMATCH';
  return 'PERSISTENT_LAUNCH_FAIL';
}

export function launchFailureHint(reason: LaunchFailureReason): string {
  switch (reason) {
    case 'ARCH_MISMATCH':
      return 'The app binary was not built for the simulator platform. Rebuild with a simulator destination or use a physical device.';
    case 'APP_NOT_INSTALLED':
      return 'The app bundle is not installed on this simulator. Run install before open.';
    case 'PERSISTENT_LAUNCH_FAIL':
      return 'The simulator repeatedly refused to launch the app. Inspect crash logs in Console.app or ~/Library/Logs/DiagnosticReports/ and consider reinstalling the app.';
    default:
      return 'The simulator failed to launch the app. Retry with --debug and inspect diagnostics log for details.';
  }
}
