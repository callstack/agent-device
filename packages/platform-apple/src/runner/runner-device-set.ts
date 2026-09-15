import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import {
  resolveIosSimulatorDeviceSetPath,
  emitDiagnostic,
  readProcessStartTime,
  acquireProcessLock,
  withProcessLock,
  type ProcessLockOwner,
} from './host.ts';

const XCTEST_DEVICE_SET_BASE_NAME = 'XCTestDevices';
const XCTEST_DEVICE_SET_BACKUP_SUFFIX = '.agent-device-backup';
const XCTEST_DEVICE_SET_LEGACY_BACKUP_PREFIX = '.agent-device-xctestdevices-backup-';
const XCTEST_DEVICE_SET_LOCK_TIMEOUT_MS = 30_000;
const XCTEST_DEVICE_SET_LOCK_POLL_MS = 100;
const XCTEST_DEVICE_SET_LOCK_OWNER_GRACE_MS = 5_000;

export type XcodebuildSimulatorSetRedirectHandle = {
  /**
   * Runs the ordered give-back — restore the host's device set, then release the lock — and reports
   * both failures, throwing the restore failure when there is one and the release failure otherwise.
   */
  release: () => Promise<void>;
  /**
   * The same ordered give-back for a caller whose own outcome is already decided — a launch that
   * failed, a teardown that ran. A release that cannot verify ownership is dropped rather than
   * thrown: that claim is spent, and the next reclaim from this process reads it as dead. A failure
   * to restore the host's own `XCTestDevices` outranks it and is thrown all the same.
   */
  releaseBestEffort: () => Promise<void>;
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

/**
 * Runs `task` with the XCTest device set redirected at this simulator's device set, and gives the
 * redirect back on every path out. The task is what owns the redirect's lifetime here, so a build
 * that failed keeps its own error and the lock it could not hand back goes to the stale-clear path
 * instead of becoming the reportable failure.
 */
export async function withXcodebuildSimulatorSetRedirect<Task>(
  device: DeviceInfo,
  task: () => Promise<Task>,
  options: XcodebuildSimulatorSetRedirectOptions = {},
): Promise<Task> {
  const redirect = await acquireXcodebuildSimulatorSetRedirect(device, options);
  if (!redirect) return await task();
  return await withProcessLock({ acquire: async () => redirect.release, task });
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

  const paths = { xctestDeviceSetPath, backupPath };

  // Undo what an earlier build left before anything here decides about this simulator. The same-set
  // check below follows symlinks, and an interrupted build leaves `XCTestDevices` symlinked into a
  // simulator's requested set: read that as "already the same set" and this run would hand the symlink
  // back and the next `xcodebuild` would build against the host's own devices. A restore that could not
  // run leaves that check and the rename below equally meaningless, so it stops the redirect as well.
  try {
    reconcileXcodebuildSimulatorSetRedirect(paths);
  } catch {
    await handBackOrRaise(paths, lockDirPath, releaseLock);
  }

  if (sameResolvedPath(requestedSetPath, xctestDeviceSetPath)) {
    // Nothing is displaced and the caller gets no handle: a lock this simulator never needed must not
    // arrive as a redirect problem, and a host device set that could not be put back still must.
    await handBackOrRaise(paths, lockDirPath, releaseLock);
    return null;
  }

  try {
    installDeviceSetRedirect(paths, requestedSetPath);
  } catch (error) {
    const handBack = await handBackDeviceSet(paths, lockDirPath, releaseLock);
    throw redirectFailure(error, handBack, { requestedSetPath, ...paths });
  }

  let givenBack = false;
  const giveBack = async (reportUnverifiedRelease: boolean): Promise<void> => {
    if (givenBack) {
      return;
    }
    givenBack = true;
    const handBack = await handBackDeviceSet(paths, lockDirPath, releaseLock);
    if (handBack.restoreFailure !== null) {
      throw handBack.restoreFailure;
    }
    if (handBack.releaseFailure !== null && reportUnverifiedRelease) {
      throw handBack.releaseFailure;
    }
  };
  return {
    release: () => giveBack(true),
    releaseBestEffort: () => giveBack(false),
  };
}

/** The two paths a redirect moves around: where the host keeps its set, and where this run put it. */
type DeviceSetPaths = {
  xctestDeviceSetPath: string;
  backupPath: string;
};

/** The rename that gives this simulator the host's slot, and the symlink that occupies it. */
function installDeviceSetRedirect(paths: DeviceSetPaths, requestedSetPath: string): void {
  fs.mkdirSync(requestedSetPath, { recursive: true });
  if (fs.existsSync(paths.xctestDeviceSetPath)) {
    fs.renameSync(paths.xctestDeviceSetPath, paths.backupPath);
  }
  installXcodebuildSimulatorSetSymlink({
    requestedSetPath,
    xctestDeviceSetPath: paths.xctestDeviceSetPath,
  });
}

/**
 * Why this redirect did not happen, plus whatever the hand-back could not put right on the way out. A
 * backup path is named only when that backup is really on disk: a reader sent to restore a path that
 * does not exist learns the wrong lesson from this error.
 */
function redirectFailure(
  cause: unknown,
  handBack: DeviceSetHandBack,
  paths: DeviceSetPaths & { requestedSetPath: string },
): AppError {
  return new AppError('COMMAND_FAILED', 'Failed to redirect XCTest device set path', {
    ...paths,
    error: String(cause),
    ...(handBack.restoreFailure === null ? {} : { restoreError: String(handBack.restoreFailure) }),
    ...(handBack.renamedAsidePath === null
      ? {}
      : {
          hint:
            `The host's own device set is still renamed aside at ${handBack.renamedAsidePath}: ` +
            'restore it, or remove that path, before another runner build redirects it.',
        }),
  });
}

/** What one ordered hand-back found, with neither failure able to hide the other. */
type DeviceSetHandBack = {
  /** The host's own `XCTestDevices` could not be put back, so a symlink or nothing is in its place. */
  restoreFailure: unknown;
  /** The path the host's own set is waiting at when a restore left it renamed aside, else null. */
  renamedAsidePath: string | null;
  /** The lock could not be given back, or could not be verified as ours when it was. */
  releaseFailure: unknown;
};

/**
 * The one ordered hand-back, used by every path that leaves this redirect behind: restore the host's
 * own device set, then release the lock, and record whatever the release could not do. Neither step can
 * hide the other, because a restore that could not run is a fact about this machine that outlives the
 * request — every later `simctl` run sees the wrong devices — and the lock going back is what keeps the
 * next acquire from waiting on a claim nobody is acting on. Which of the two a caller *hears* stays with
 * the caller: a redirect that failed reports both, and one that merely ended reports the restore.
 */
async function handBackDeviceSet(
  paths: DeviceSetPaths,
  lockDirPath: string,
  releaseLock: () => Promise<void>,
): Promise<DeviceSetHandBack> {
  let restoreFailure: unknown = null;
  let renamedAsidePath: string | null = null;
  let releaseFailure: unknown = null;
  try {
    // Idempotent, so an exit that already reconciled on its way to this decision pays only a look.
    reconcileXcodebuildSimulatorSetRedirect(paths);
  } catch (error) {
    restoreFailure = error;
    // Observed here, while the lock is still held and the release has not moved anything.
    renamedAsidePath = findDeviceSetBackup(paths.backupPath);
  }
  try {
    await releaseLock();
  } catch (error) {
    releaseFailure = error;
  }
  recordReleaseFailure(releaseFailure, lockDirPath);
  return { restoreFailure, renamedAsidePath, releaseFailure };
}

/**
 * Hands the device set back for an exit that has no report of its own to make, and raises the restore
 * when the host's own set is still not in place. The hand-back records the release, so there is nothing
 * here that could read one half of its result and miss the other.
 */
async function handBackOrRaise(
  paths: DeviceSetPaths,
  lockDirPath: string,
  releaseLock: () => Promise<void>,
): Promise<void> {
  const { restoreFailure } = await handBackDeviceSet(paths, lockDirPath, releaseLock);
  if (restoreFailure !== null) {
    throw restoreFailure;
  }
}

/**
 * The backup that holds the host's own device set, when one is really on disk. The path this run would
 * have written is not the only candidate: an older version renamed it beside a different name, and that
 * leftover is just as much the host's device set.
 */
function findDeviceSetBackup(backupPath: string): string | null {
  return (
    [backupPath, ...findLegacyXcodebuildSimulatorSetBackups(backupPath)].find((candidate) =>
      fs.existsSync(candidate),
    ) ?? null
  );
}

/**
 * Records a lock release that no caller is being made to throw. A release whose ownership could not be
 * verified is already recorded where the claim lives, so only the rest reaches the log.
 */
function recordReleaseFailure(error: unknown, lockDirPath: string): void {
  if (error === null || isOwnerReleaseUnverified(error)) {
    return;
  }
  emitDiagnostic({
    level: 'warn',
    phase: 'ios_runner_xctest_device_set_hand_back_failed',
    data: { lockDirPath, error: String(error) },
  });
}

function isOwnerReleaseUnverified(error: unknown): boolean {
  return error instanceof AppError && error.details?.ownerReleaseUnverified === true;
}

// fallow-ignore-next-line complexity
function reconcileXcodebuildSimulatorSetRedirect(paths: {
  xctestDeviceSetPath: string;
  backupPath: string;
}): void {
  const { xctestDeviceSetPath, backupPath } = paths;
  const existingBackups = [backupPath, ...findLegacyXcodebuildSimulatorSetBackups(backupPath)];
  const activeBackupPath = existingBackups.find((candidate) => fs.existsSync(candidate));
  const xctestIsSymlink = isSymlink(xctestDeviceSetPath);

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
    unlinkIfSymlink(tmpSymlinkPath);
    throw error;
  }
}

// lstat instead of existsSync: existsSync follows symlinks, so a dangling
// symlink (target deleted) would read as absent and never get cleaned up.
function isSymlink(targetPath: string): boolean {
  return fs.lstatSync(targetPath, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
}

function unlinkIfSymlink(targetPath: string): void {
  if (isSymlink(targetPath)) {
    fs.unlinkSync(targetPath);
  }
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
