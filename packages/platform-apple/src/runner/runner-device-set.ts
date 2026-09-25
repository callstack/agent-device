import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { resolveIosSimulatorDeviceSetPath } from './host.ts';

/** The scoped simulator set that holds this runner's simulator, or undefined for the default set. */
function resolveRunnerSimulatorSetPath(device: DeviceInfo): string | undefined {
  if (!isIosFamily(device) || device.kind !== 'simulator') return undefined;
  return resolveIosSimulatorDeviceSetPath(device.simulatorSetPath);
}

/**
 * `-destination` for a runner xcodebuild phase. xcodebuild has no `--set` option: it resolves a
 * simulator in a scoped set only through the `DVTSimulatorSetLocation` Xcode user default, which it
 * accepts as an argument in the `-Key=value` form alone.
 */
export function xcodebuildDestinationArgs(device: DeviceInfo, destination: string): string[] {
  const simulatorSetPath = resolveRunnerSimulatorSetPath(device);
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
 * own scoped set, so a host that links `XCTestDevices` elsewhere keeps its link.
 */
export function restoreLegacyXctestDeviceSetRedirect(
  device: DeviceInfo,
  xctestDeviceSetPath: string = path.join(os.homedir(), 'Library', 'Developer', 'XCTestDevices'),
): void {
  const backupPath = `${xctestDeviceSetPath}.agent-device-backup`;
  const backupExists = fs.existsSync(backupPath);
  const isSymlink =
    fs.lstatSync(xctestDeviceSetPath, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
  if (
    isSymlink &&
    (backupExists || linkPointsAt(xctestDeviceSetPath, resolveRunnerSimulatorSetPath(device)))
  ) {
    fs.unlinkSync(xctestDeviceSetPath);
  }
  if (backupExists && !fs.existsSync(xctestDeviceSetPath)) {
    fs.renameSync(backupPath, xctestDeviceSetPath);
  }
}

function linkPointsAt(linkPath: string, targetPath: string | undefined): boolean {
  if (targetPath === undefined) return false;
  return (
    path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath)) === path.resolve(targetPath)
  );
}

/** What a runner xcodebuild failure reports about the scoped set it resolved its destination in. */
export function runnerSimulatorSetFailureDetails(
  device: DeviceInfo,
  xcodeVersion: string | undefined,
): { simulatorSetPath?: string; xcodeVersion?: string } {
  const simulatorSetPath = resolveRunnerSimulatorSetPath(device);
  return simulatorSetPath === undefined ? {} : { simulatorSetPath, xcodeVersion };
}
