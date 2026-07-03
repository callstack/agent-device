import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../../../../kernel/errors.ts';
import { isIosFamily, type DeviceInfo } from '../../../../kernel/device.ts';
import { resolveIosSimulatorDeviceSetPath } from '../../../../utils/device-isolation.ts';
import { emitDiagnostic } from '../../../../utils/diagnostics.ts';
import { readProcessStartTime } from '../../../../utils/process-identity.ts';
import { acquireProcessLock, type ProcessLockOwner } from '../../../../utils/process-lock.ts';

const XCTEST_DEVICE_SET_BASE_NAME = 'XCTestDevices';
const XCTEST_DEVICE_SET_BACKUP_SUFFIX = '.agent-device-backup';
const XCTEST_DEVICE_SET_LEGACY_BACKUP_PREFIX = '.agent-device-xctestdevices-backup-';
const XCTEST_DEVICE_SET_LOCK_TIMEOUT_MS = 30_000;
const XCTEST_DEVICE_SET_LOCK_POLL_MS = 100;
const XCTEST_DEVICE_SET_LOCK_OWNER_GRACE_MS = 5_000;

type XcodebuildSimulatorSetRedirectHandle = {
  release: () => Promise<void>;
};

type XcodebuildSimulatorSetRedirectOptions = {
  xctestDeviceSetPath?: string;
  backupPath?: string;
  lockDirPath?: string;
  ownerPid?: number;
  ownerStartTime?: string | null;
  nowMs?: number;
};

export function resolveXcodebuildSimulatorDeviceSetPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, 'Library', 'Developer', 'XCTestDevices');
}

function resolveXcodebuildSimulatorDeviceSetLockPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.agent-device', 'xctest-device-set.lock');
}

function resolveXcodebuildSimulatorDeviceSetBackupPath(
  xctestDeviceSetPath: string = resolveXcodebuildSimulatorDeviceSetPath(),
): string {
  return `${xctestDeviceSetPath}${XCTEST_DEVICE_SET_BACKUP_SUFFIX}`;
}

export async function acquireXcodebuildSimulatorSetRedirect(
  device: DeviceInfo,
  options: XcodebuildSimulatorSetRedirectOptions = {},
): Promise<XcodebuildSimulatorSetRedirectHandle | null> {
  if (!isIosFamily(device) || device.kind !== 'simulator') {
    return null;
  }
  const simulatorSetPath = resolveIosSimulatorDeviceSetPath(device.simulatorSetPath);
  if (!simulatorSetPath) {
    return null;
  }
  const requestedSetPath = path.resolve(simulatorSetPath);
  const xctestDeviceSetPath = path.resolve(
    options.xctestDeviceSetPath ?? resolveXcodebuildSimulatorDeviceSetPath(),
  );
  const backupPath = path.resolve(
    options.backupPath ?? resolveXcodebuildSimulatorDeviceSetBackupPath(xctestDeviceSetPath),
  );
  const lockDirPath = path.resolve(
    options.lockDirPath ?? resolveXcodebuildSimulatorDeviceSetLockPath(),
  );
  const ownerStartTime = options.ownerStartTime ?? readProcessStartTime(process.pid);
  const releaseLock = await acquireXcodebuildSimulatorSetLock({
    lockDirPath,
    owner: {
      pid: options.ownerPid ?? process.pid,
      startTime: ownerStartTime,
      acquiredAtMs: options.nowMs ?? Date.now(),
    },
  });

  try {
    reconcileXcodebuildSimulatorSetRedirect({
      xctestDeviceSetPath,
      backupPath,
    });
    if (sameResolvedPath(requestedSetPath, xctestDeviceSetPath)) {
      await releaseLock();
      return null;
    }

    fs.mkdirSync(requestedSetPath, { recursive: true });
    if (fs.existsSync(xctestDeviceSetPath)) {
      fs.renameSync(xctestDeviceSetPath, backupPath);
    }
    installXcodebuildSimulatorSetSymlink({
      requestedSetPath,
      xctestDeviceSetPath,
    });
  } catch (error) {
    reconcileXcodebuildSimulatorSetRedirect({
      xctestDeviceSetPath,
      backupPath,
    });
    await releaseLock();
    throw new AppError('COMMAND_FAILED', 'Failed to redirect XCTest device set path', {
      requestedSetPath,
      xctestDeviceSetPath,
      backupPath,
      error: String(error),
    });
  }

  let released = false;
  return {
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      try {
        reconcileXcodebuildSimulatorSetRedirect({
          xctestDeviceSetPath,
          backupPath,
        });
      } finally {
        await releaseLock();
      }
    },
  };
}

// fallow-ignore-next-line complexity
function reconcileXcodebuildSimulatorSetRedirect(paths: {
  xctestDeviceSetPath: string;
  backupPath: string;
}): void {
  const { xctestDeviceSetPath, backupPath } = paths;
  const existingBackups = [backupPath, ...findLegacyXcodebuildSimulatorSetBackups(backupPath)];
  const activeBackupPath = existingBackups.find((candidate) => fs.existsSync(candidate));
  const xctestExists = fs.existsSync(xctestDeviceSetPath);
  const xctestIsSymlink = xctestExists && fs.lstatSync(xctestDeviceSetPath).isSymbolicLink();

  if (activeBackupPath) {
    if (xctestIsSymlink) {
      unlinkIfSymlink(xctestDeviceSetPath);
    }
    if (!fs.existsSync(xctestDeviceSetPath)) {
      fs.mkdirSync(path.dirname(xctestDeviceSetPath), { recursive: true });
      fs.renameSync(activeBackupPath, xctestDeviceSetPath);
    } else if (!xctestIsSymlink) {
      emitDiagnostic({
        level: 'warn',
        phase: 'ios_runner_xctest_device_set_restore_collision',
        data: {
          xctestDeviceSetPath,
          activeBackupPath,
        },
      });
      return;
    } else if (activeBackupPath !== backupPath) {
      fs.rmSync(activeBackupPath, { recursive: true, force: true });
    } else {
      fs.rmSync(backupPath, { recursive: true, force: true });
    }
    for (const candidate of existingBackups) {
      if (candidate !== activeBackupPath && fs.existsSync(candidate)) {
        fs.rmSync(candidate, { recursive: true, force: true });
      }
    }
    return;
  }

  if (xctestIsSymlink) {
    emitDiagnostic({
      level: 'warn',
      phase: 'ios_runner_xctest_device_set_orphaned_symlink',
      data: {
        xctestDeviceSetPath,
      },
    });
    unlinkIfSymlink(xctestDeviceSetPath);
  }
}

function findLegacyXcodebuildSimulatorSetBackups(backupPath: string): string[] {
  const parentDir = path.dirname(backupPath);
  const backupBaseName = path.basename(backupPath).replace(XCTEST_DEVICE_SET_BACKUP_SUFFIX, '');
  const legacyPrefix =
    backupBaseName === XCTEST_DEVICE_SET_BASE_NAME
      ? XCTEST_DEVICE_SET_LEGACY_BACKUP_PREFIX
      : `${backupBaseName}${XCTEST_DEVICE_SET_LEGACY_BACKUP_PREFIX}`;
  try {
    return fs
      .readdirSync(parentDir)
      .filter((entry) => entry.startsWith(legacyPrefix))
      .sort()
      .map((entry) => path.join(parentDir, entry));
  } catch {
    return [];
  }
}

function installXcodebuildSimulatorSetSymlink(paths: {
  requestedSetPath: string;
  xctestDeviceSetPath: string;
}): void {
  const { requestedSetPath, xctestDeviceSetPath } = paths;
  const parentDir = path.dirname(xctestDeviceSetPath);
  const tmpSymlinkPath = path.join(
    parentDir,
    `${XCTEST_DEVICE_SET_BASE_NAME}.agent-device-link-${process.pid}-${Date.now()}`,
  );
  fs.mkdirSync(parentDir, { recursive: true });
  try {
    fs.symlinkSync(requestedSetPath, tmpSymlinkPath, 'dir');
    fs.renameSync(tmpSymlinkPath, xctestDeviceSetPath);
  } catch (error) {
    if (fs.existsSync(tmpSymlinkPath)) {
      unlinkIfSymlink(tmpSymlinkPath);
    }
    throw error;
  }
}

function unlinkIfSymlink(targetPath: string): void {
  if (!fs.existsSync(targetPath)) {
    return;
  }
  if (!fs.lstatSync(targetPath).isSymbolicLink()) {
    return;
  }
  fs.unlinkSync(targetPath);
}

function sameResolvedPath(left: string, right: string): boolean {
  if (path.resolve(left) === path.resolve(right)) {
    return true;
  }
  try {
    return fs.realpathSync.native(left) === fs.realpathSync.native(right);
  } catch {
    return false;
  }
}

async function acquireXcodebuildSimulatorSetLock(params: {
  lockDirPath: string;
  owner: ProcessLockOwner;
  timeoutMs?: number;
  pollMs?: number;
  description?: string;
}): Promise<() => Promise<void>> {
  return await acquireProcessLock({
    lockDirPath: params.lockDirPath,
    owner: params.owner,
    timeoutMs: params.timeoutMs ?? XCTEST_DEVICE_SET_LOCK_TIMEOUT_MS,
    pollMs: params.pollMs ?? XCTEST_DEVICE_SET_LOCK_POLL_MS,
    ownerGraceMs: XCTEST_DEVICE_SET_LOCK_OWNER_GRACE_MS,
    description: params.description ?? 'XCTest device set lock',
  });
}
