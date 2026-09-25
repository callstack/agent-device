import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { simulatorAddressFor } from './host.ts';
import { memoizedRunnerXcodeVersion } from './runner-cache-metadata.ts';

/** The scoped simulator set that holds this runner's simulator, or undefined for the default set. */
export function runnerSimulatorSetPath(device: DeviceInfo): string | undefined {
  return simulatorAddressFor(device).simulatorSetPath;
}

/** Whether a runner started for one device serves the other: one udid in one simulator set. */
export function isSameRunnerSimulator(runnerDevice: DeviceInfo, device: DeviceInfo): boolean {
  const runner = simulatorAddressFor(runnerDevice);
  const requested = simulatorAddressFor(device);
  return runner.udid === requested.udid && runner.simulatorSetPath === requested.simulatorSetPath;
}

/**
 * `-destination` for a runner xcodebuild phase. xcodebuild has no `--set` option: it resolves a
 * simulator in a scoped set only through the `DVTSimulatorSetLocation` Xcode user default, which it
 * accepts as an argument in the `-Key=value` form alone.
 */
export function xcodebuildDestinationArgs(device: DeviceInfo, destination: string): string[] {
  const simulatorSetPath = runnerSimulatorSetPath(device);
  return simulatorSetPath === undefined
    ? ['-destination', destination]
    : ['-destination', destination, `-DVTSimulatorSetLocation=${simulatorSetPath}`];
}

/** One step of the legacy `XCTestDevices` restore, for the daemon to record once its log is published. */
type LegacyXctestDeviceSetRestoreDiagnostic = Readonly<{
  phase:
    | 'ios_runner_legacy_xctest_device_set_link_removed'
    | 'ios_runner_legacy_xctest_device_set_backup_restored'
    | 'ios_runner_legacy_xctest_device_set_restore_failed';
  resourcePath: string;
  data: Readonly<Record<string, unknown>>;
}>;

/**
 * Puts the host's own `~/Library/Developer/XCTestDevices` back where an older agent-device left it
 * redirected into a scoped simulator set: a symlink in its place, with the real directory renamed to
 * `XCTestDevices.agent-device-backup` when one existed. Xcode's first-launch cleanup deletes every
 * device in `XCTestDevices`, so a symlink left there deletes the set it points at. A symlinked
 * `XCTestDevices` is unsupported: any symlink there is removed, as released versions did on every
 * scoped runner start; unlinking deletes no data. Daemons starting together may both undo it: a step
 * the other daemon already took is done, not a failure. Best effort: a failure is reported, not
 * thrown.
 */
export function restoreLegacyXctestDeviceSetRedirect(
  onDiagnostic: (diagnostic: LegacyXctestDeviceSetRestoreDiagnostic) => void,
  xctestDeviceSetPath: string = path.join(os.homedir(), 'Library', 'Developer', 'XCTestDevices'),
): void {
  const backupPath = `${xctestDeviceSetPath}.agent-device-backup`;
  try {
    if (isSymlinkAt(xctestDeviceSetPath)) {
      const linkTarget = readLinkTarget(xctestDeviceSetPath);
      removeSymlinkUnlessGone(xctestDeviceSetPath);
      onDiagnostic({
        phase: 'ios_runner_legacy_xctest_device_set_link_removed',
        resourcePath: xctestDeviceSetPath,
        data: { linkTarget },
      });
    }
    if (fs.existsSync(backupPath) && !fs.existsSync(xctestDeviceSetPath)) {
      restoreBackupUnlessRestored(backupPath, xctestDeviceSetPath);
      onDiagnostic({
        phase: 'ios_runner_legacy_xctest_device_set_backup_restored',
        resourcePath: xctestDeviceSetPath,
        data: { backupPath },
      });
    }
  } catch (error) {
    onDiagnostic({
      phase: 'ios_runner_legacy_xctest_device_set_restore_failed',
      resourcePath: xctestDeviceSetPath,
      data: { error: error instanceof Error ? error.message : String(error) },
    });
  }
}

function removeSymlinkUnlessGone(linkPath: string): void {
  try {
    fs.unlinkSync(linkPath);
  } catch (error) {
    if (isSymlinkAt(linkPath)) throw error;
  }
}

function restoreBackupUnlessRestored(backupPath: string, restoredPath: string): void {
  try {
    fs.renameSync(backupPath, restoredPath);
  } catch (error) {
    if (fs.existsSync(backupPath) && !fs.existsSync(restoredPath)) throw error;
  }
}

function isSymlinkAt(filePath: string): boolean {
  return fs.lstatSync(filePath, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
}

function readLinkTarget(linkPath: string): string | undefined {
  try {
    return fs.readlinkSync(linkPath);
  } catch {
    return undefined;
  }
}

/** What a runner xcodebuild failure reports about the scoped set it resolved its destination in. */
type RunnerSimulatorSetFailureDetails = { simulatorSetPath?: string; xcodeVersion?: string };

/**
 * The scoped set a runner xcodebuild phase resolved its destination in, with the selected Xcode when
 * the runner cache decision already read it; empty for the default set.
 */
export function runnerSimulatorSetFailureDetails(
  device: DeviceInfo,
): RunnerSimulatorSetFailureDetails {
  const simulatorSetPath = runnerSimulatorSetPath(device);
  if (simulatorSetPath === undefined) return {};
  const xcodeVersion = memoizedRunnerXcodeVersion(device);
  return xcodeVersion === undefined ? { simulatorSetPath } : { simulatorSetPath, xcodeVersion };
}

/** Names the simulator, the scoped set and the Xcode behind a `simulator_set_destination_not_found`. */
export function simulatorSetDestinationNotFoundMessage(
  message: string,
  device: DeviceInfo,
  details: RunnerSimulatorSetFailureDetails,
): string {
  return `${message}: xcodebuild found no simulator ${device.id} in simulator set ${details.simulatorSetPath} with Xcode ${details.xcodeVersion ?? '(version unreadable)'}`;
}
