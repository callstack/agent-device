import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import {
  resolveIosSimulatorDeviceSetPath,
  emitDiagnostic,
  readProcessStartTime,
  acquireProcessLock,
  withProcessLock,
  probeXcrunShimFirstLaunchHooks,
  type ArmedXcrunShimFirstLaunchHook,
  type XcrunShimArmedBy,
  type XcrunShimProbeOptions,
} from './host.ts';
import type { ProcessLockRelease } from '@agent-device/host-kit/file';
import { classifyRunnerStartupFailure } from './runner-error-classification.ts';
import { runnerPhaseBudgetExhaustedError } from './runner-cache-metadata.ts';

const XCTEST_DEVICE_SET_BASE_NAME = 'XCTestDevices';
const XCTEST_DEVICE_SET_BACKUP_SUFFIX = '.agent-device-backup';
const XCTEST_DEVICE_SET_LEGACY_BACKUP_PREFIX = '.agent-device-xctestdevices-backup-';
const XCTEST_DEVICE_SET_LOCK_TIMEOUT_MS = 30_000;
const XCTEST_DEVICE_SET_LOCK_POLL_MS = 100;
const XCTEST_DEVICE_SET_LOCK_OWNER_GRACE_MS = 5_000;
const XCRUN_SHIM_PROBE_PHASE = 'xctest_device_set_shim_probe';

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

type XcodebuildSimulatorSetRedirectOptions = XcrunShimProbeOptions & {
  xctestDeviceSetPath?: string;
  backupPath?: string;
  lockDirPath?: string;
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
  options: XcodebuildSimulatorSetRedirectOptions,
  task: () => Promise<Task>,
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
  const releaseLock = await acquireProcessLock({
    lockDirPath,
    owner: {
      pid: process.pid,
      startTime: readProcessStartTime(process.pid),
      acquiredAtMs: Date.now(),
    },
    timeoutMs: XCTEST_DEVICE_SET_LOCK_TIMEOUT_MS,
    pollMs: XCTEST_DEVICE_SET_LOCK_POLL_MS,
    ownerGraceMs: XCTEST_DEVICE_SET_LOCK_OWNER_GRACE_MS,
    description: 'XCTest device set lock',
  });

  const paths = { xctestDeviceSetPath, backupPath };
  let needsRedirect = false;
  let redirectRefusal: AppError | null = null;

  // One try, so the lock cannot be given back and then worked under: the restore of an interrupted
  // build's leftovers runs first because the same-set check follows symlinks, and `XCTestDevices` left
  // pointing into this simulator's requested set would otherwise read as "already redirected" and hand
  // the next build the host's own devices.
  try {
    reconcileXcodebuildSimulatorSetRedirect(paths);
    needsRedirect = !sameResolvedPath(requestedSetPath, xctestDeviceSetPath);
    if (needsRedirect) {
      redirectRefusal = await xcrunShimProbeRefusal(options);
    }
    if (needsRedirect && redirectRefusal === null) {
      installDeviceSetRedirect(paths, requestedSetPath);
    }
  } catch (error) {
    // Anything the hand-back could not undo travels with this report; the lock never outlives the
    // failure that ends the acquire.
    const handBack = await handBackDeviceSet(paths, lockDirPath, releaseLock);
    throw redirectFailure(error, handBack, { requestedSetPath, ...paths });
  }

  if (redirectRefusal !== null) {
    await handBackOrThrowRestoreFailure(paths, lockDirPath, releaseLock);
    throw redirectRefusal;
  }

  if (!needsRedirect) {
    // Nothing is displaced and the caller gets no handle: a lock this simulator never needed must not
    // arrive as a redirect problem, and a host device set that could not be put back still must.
    await handBackOrThrowRestoreFailure(paths, lockDirPath, releaseLock);
    return null;
  }

  let givenBack = false;
  const giveBack = async (reportUnverifiedRelease: boolean): Promise<void> => {
    if (givenBack) {
      return;
    }
    givenBack = true;
    const handBack = await handBackOrThrowRestoreFailure(paths, lockDirPath, releaseLock);
    if (handBack.releaseFailure !== null && reportUnverifiedRelease) {
      throw handBack.releaseFailure;
    }
  };
  return {
    release: () => giveBack(true),
    releaseBestEffort: () => giveBack(false),
  };
}

/**
 * Why the redirect may not go ahead, or null when every shim is safe. A host where an Xcode shim
 * would run `xcodebuild -runFirstLaunch` — which deletes every device in `XCTestDevices` and so,
 * through the redirect, every device in the requested set — is refused with the reason and hint
 * {@link classifyRunnerStartupFailure} keys on `xcrunShims`. A probe the request canceled gets the
 * canceled-request error, and one the owning phase's clock stopped gets the phase's budget error;
 * neither is a host refusal.
 */
async function xcrunShimProbeRefusal(options: XcrunShimProbeOptions): Promise<AppError | null> {
  const probe = await probeXcrunShimFirstLaunchHooks({
    signal: options.signal,
    deadline: options.deadline,
  });
  if (probe.outcome === 'request_canceled') {
    return createRequestCanceledError({ phase: XCRUN_SHIM_PROBE_PHASE });
  }
  if (probe.outcome === 'phase_budget_exhausted') {
    return runnerPhaseBudgetExhaustedError(XCRUN_SHIM_PROBE_PHASE);
  }
  const { xcrunShims } = probe;
  const armed = xcrunShims.filter(
    (shim): shim is ArmedXcrunShimFirstLaunchHook => shim.hook === 'armed',
  );
  if (armed.length === 0) return null;
  const described = armed.map((shim) => DESCRIBE_ARMED_SHIM[shim.armedBy](shim));
  const message = `Refusing to redirect XCTest device set: ${described.join('; ')}`;
  const { reason, hint } = classifyRunnerStartupFailure(
    new AppError('COMMAND_FAILED', message, { xcrunShims }),
  );
  return new AppError('COMMAND_FAILED', message, { reason, hint, xcrunShims });
}

const DESCRIBE_ARMED_SHIM: Record<
  XcrunShimArmedBy,
  (shim: ArmedXcrunShimFirstLaunchHook) => string
> = {
  version_mismatch: describeShimVersions,
  version_unreadable: describeShimVersions,
  shim_unreadable: (shim) => `Xcode's ${shim.tool} shim at ${shim.shimPath} could not be read`,
  shim_not_located: (shim) => `Xcode's ${shim.tool} could not be located`,
  probe_out_of_budget: (shim) => `Xcode's ${shim.tool} shim was not read within the probe budget`,
};

function describeShimVersions(shim: ArmedXcrunShimFirstLaunchHook): string {
  const framework =
    /([^/]+)\.framework\//.exec(shim.frameworkInfoPlistPath ?? '')?.[1] ?? 'its framework';
  return (
    `Xcode's ${shim.tool} expects ${framework} ${shim.expectedVersion ?? '(unreadable)'}; ` +
    `installed ${shim.installedVersion ?? '(unreadable)'}`
  );
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
  releaseLock: ProcessLockRelease,
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
    renamedAsidePath = findDeviceSetBackup(paths);
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
 * The hand-back every exit that does not already have a more specific error uses: a restore failure
 * outranks whatever that exit was about to report, because it is a fact about this machine's device set
 * that outlives the request.
 */
async function handBackOrThrowRestoreFailure(
  paths: DeviceSetPaths,
  lockDirPath: string,
  releaseLock: ProcessLockRelease,
): Promise<DeviceSetHandBack> {
  const handBack = await handBackDeviceSet(paths, lockDirPath, releaseLock);
  if (handBack.restoreFailure !== null) {
    throw handBack.restoreFailure;
  }
  return handBack;
}

/**
 * Where the host's own device set sits when it is not in place: the backup this run would have written,
 * or the older name an earlier version used, but only while it is really on disk. Once the host's set is
 * back at its own path nothing is renamed aside, and naming a leftover backup would point a reader at a
 * copy they could restore over the set in use.
 */
function findDeviceSetBackup(paths: DeviceSetPaths): string | null {
  const { xctestDeviceSetPath, backupPath } = paths;
  if (!isSymlink(xctestDeviceSetPath) && fs.existsSync(xctestDeviceSetPath)) {
    // The host's own set is back where it belongs. Any backup still on disk is a leftover of an older
    // interruption, and sending a reader to copy it back would overwrite the set that is in place.
    return null;
  }
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
