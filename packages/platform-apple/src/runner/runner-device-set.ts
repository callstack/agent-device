import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { simulatorAddressFor } from './host.ts';
import { readRunnerXcodeVersion } from './runner-cache-metadata.ts';

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

/**
 * Puts the host's own `~/Library/Developer/XCTestDevices` back where an older agent-device left it
 * redirected: a symlink into a scoped set, with the real directory renamed to
 * `XCTestDevices.agent-device-backup`. Xcode's first-launch cleanup deletes every device in
 * `XCTestDevices`, so a symlink left there deletes the scoped set it points at. Only that state is
 * undone: a symlink is removed when the backup beside it exists, or when it points at this runner's
 * own scoped set, so a host that links `XCTestDevices` elsewhere keeps its link. Daemons starting
 * together may both undo it: a step the other daemon already took is done, not a failure.
 */
export function restoreLegacyXctestDeviceSetRedirect(
  device: DeviceInfo,
  xctestDeviceSetPath: string = path.join(os.homedir(), 'Library', 'Developer', 'XCTestDevices'),
): void {
  const backupPath = `${xctestDeviceSetPath}.agent-device-backup`;
  const backupExists = fs.existsSync(backupPath);
  if (
    isSymlinkAt(xctestDeviceSetPath) &&
    (backupExists || linkPointsAt(xctestDeviceSetPath, runnerSimulatorSetPath(device)))
  ) {
    removeSymlinkUnlessGone(xctestDeviceSetPath);
  }
  if (backupExists && !fs.existsSync(xctestDeviceSetPath)) {
    restoreBackupUnlessRestored(backupPath, xctestDeviceSetPath);
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

function linkPointsAt(linkPath: string, targetPath: string | undefined): boolean {
  if (targetPath === undefined) return false;
  let linkTarget: string;
  try {
    linkTarget = fs.readlinkSync(linkPath);
  } catch (error) {
    if (isSymlinkAt(linkPath)) throw error;
    return false;
  }
  return path.resolve(path.dirname(linkPath), linkTarget) === path.resolve(targetPath);
}

/** What a runner xcodebuild failure reports about the scoped set it resolved its destination in. */
type RunnerSimulatorSetFailureDetails = { simulatorSetPath?: string; xcodeVersion?: string };

/**
 * The scoped set a runner xcodebuild phase resolved its destination in, with the selected Xcode when
 * the toolchain answers; empty for the default set.
 */
export function runnerSimulatorSetFailureDetails(
  device: DeviceInfo,
): RunnerSimulatorSetFailureDetails {
  const simulatorSetPath = runnerSimulatorSetPath(device);
  if (simulatorSetPath === undefined) return {};
  const xcodeVersion = readRunnerXcodeVersion(device);
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
