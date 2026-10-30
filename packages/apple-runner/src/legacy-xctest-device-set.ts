import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResourceDiagnostic } from '@agent-device/host-kit/diagnostics';

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
  onDiagnostic: (diagnostic: ResourceDiagnostic) => void,
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
