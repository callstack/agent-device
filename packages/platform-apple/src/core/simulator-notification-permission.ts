import {
  readHostBinaryFile,
  removeHostPath,
  renameHostPath,
  writeHostBinaryFile,
} from '@agent-device/host-kit/host-file';
import { Deadline, sleep } from '@agent-device/host-kit/retry';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import type { PlistValue } from 'plist';
import { readLaunchctlJobs, uiKitApplicationBundleId } from './launchctl-jobs.ts';
import { readApplePlist } from './plist.ts';

/** The file under a simulator's data directory where SpringBoard keeps each app's notification settings. */
export const SIMULATOR_NOTIFICATION_SETTINGS_FILE =
  'Library/BulletinBoard/VersionedSectionInfo.plist';

export const SIMULATOR_NOTIFICATION_REASONS = {
  // The simulator's files are not on this host, so its notification settings cannot be written.
  unreachable: { reason: 'ios-notification-settings-unreachable' },
  // The simulator has no notification settings file yet; SpringBoard creates it on its first start.
  missing: { reason: 'ios-notification-settings-missing' },
  // The notification settings file is not in the layout this command writes, so it is left alone.
  unrecognized: { reason: 'ios-notification-settings-unrecognized' },
  // SpringBoard or usernotificationsd did not stop, or SpringBoard did not start, within 10 seconds.
  restartTimeout: { reason: 'ios-notification-restart-timeout' },
  // The file read back after the restart does not hold the written status.
  notApplied: { reason: 'ios-notification-settings-not-applied' },
} as const satisfies ReasonTable<'settings'>;

/** The `sectionInfoVersionNumber` of the layout the written record follows (iOS 27). */
const SECTION_INFO_VERSION = 3;

/** `BBSectionInfoSettings.authorizationStatus`, as `UNAuthorizationStatus` numbers it. */
const AUTHORIZATION_STATUS = { grant: 2, revoke: 1 } as const;

/** The services that hold the settings in memory, and write them back to the file as they stop. */
const NOTIFICATION_SERVICES = ['com.apple.SpringBoard', 'com.apple.usernotificationsd'];
const SPRINGBOARD = 'com.apple.SpringBoard';

/** How long a stop or a start may take before the change fails, and how often it is read. */
const SERVICE_WAIT_MS = 10_000;
const SERVICE_POLL_MS = 200;

/** Seconds from the Unix epoch to the Cocoa reference date, 2001-01-01. */
const COCOA_EPOCH_SECONDS = 978_307_200;

export const SPRINGBOARD_RESTART_WARNING =
  'Restarted SpringBoard to apply the notification permission, so the simulator is back on the Home Screen. Change notifications before open, then open the app.';

type NotificationPermissionRequest = {
  runSimctl: (args: string[]) => Promise<{ readonly stdout: string }>;
  udid: string;
  deviceId: string;
  appBundleId: string;
  action: 'grant' | 'revoke' | 'reset';
  /** The settings file on this host; absent where the runner cannot reach the simulator's files. */
  settingsPath: string | undefined;
};

/**
 * What a change did: nothing when the file already held it, else a restart, which brings back the
 * app when it was running so a test that changes notifications mid-flow keeps its app in front. The
 * app can outlive the restart, but iOS ends it on a deny or reset, and then `simctl launch` starts it fresh.
 */
export type NotificationPermissionOutcome =
  | { restarted: false }
  | { restarted: true; reopened: boolean; reopenFailure?: string };

type SettingsFile = {
  format: 'xml' | 'binary';
  store: Record<string, PlistValue>;
  sections: Record<string, PlistValue>;
};

/**
 * Sets an app's notification permission on a simulator. `simctl privacy` refuses notifications, so
 * this writes the record SpringBoard keeps when a user answers the prompt: one NSKeyedArchiver
 * `BBSectionInfo` per bundle id, or none for a reset. SpringBoard and `usernotificationsd` write
 * their copy back as they stop, so the edit lands between their stop and start, and the restart
 * leaves the simulator on the Home Screen. A file in any other layout is refused, not rewritten.
 */
export async function setSimulatorNotificationPermission(
  request: NotificationPermissionRequest,
): Promise<NotificationPermissionOutcome> {
  const { runSimctl, udid, settingsPath, appBundleId } = request;
  if (settingsPath === undefined) {
    throw notificationSettingsError(
      request,
      'unreachable',
      'iOS simulator notification permission needs the simulator files on this host.',
      'Answer the app notification prompt instead, or use a simulator on the host that runs agent-device.',
    );
  }
  // Read before the stop as well, so a file this cannot write refuses without a restart. SpringBoard
  // writes a prompt answer to the file at once (iOS 27.2), so a file that already holds the status
  // is what the services hold too.
  const wanted = wantedStatus(request.action);
  const current = await readSettingsFile(request, settingsPath);
  if ((await recordedStatus(current, appBundleId)) === wanted) return { restarted: false };
  const before = jobProcesses(await listJobs(request));
  const wasRunning = [...before.keys()].some(
    (label) => uiKitApplicationBundleId(label) === appBundleId,
  );
  try {
    for (const service of NOTIFICATION_SERVICES) {
      await runSimctl(['spawn', udid, 'launchctl', 'stop', service]);
    }
    // `launchctl stop` only signals, and a process still exiting writes its copy over the edit.
    // launchd starts SpringBoard again at once (iOS 27.2), so a process is gone once its pid is.
    await waitForJobs(request, 'stop', (pids) =>
      NOTIFICATION_SERVICES.every(
        (label) => !before.has(label) || pids.get(label) !== before.get(label),
      ),
    );
    const file = await readSettingsFile(request, settingsPath);
    if (request.action === 'reset') {
      delete file.sections[request.appBundleId];
    } else {
      file.sections[request.appBundleId] = await sectionInfoArchive(
        request.appBundleId,
        AUTHORIZATION_STATUS[request.action],
      );
    }
    await writeSettingsFile(settingsPath, file);
  } finally {
    for (const service of NOTIFICATION_SERVICES) {
      await runSimctl(['spawn', udid, 'launchctl', 'start', service]);
    }
  }
  await waitForJobs(request, 'start', (pids) => pids.has(SPRINGBOARD));
  const written = await readSettingsFile(request, settingsPath);
  if ((await recordedStatus(written, appBundleId)) !== wanted) {
    throw new AppError(
      'COMMAND_FAILED',
      `iOS simulator notification settings for ${appBundleId} did not hold after SpringBoard restarted.`,
      {
        reason: SIMULATOR_NOTIFICATION_REASONS.notApplied.reason,
        deviceId: request.deviceId,
        appBundleId,
      },
    );
  }
  if (!wasRunning) return { restarted: true, reopened: false };
  try {
    await runSimctl(['launch', udid, appBundleId]);
    return { restarted: true, reopened: true };
  } catch (error) {
    return { restarted: true, reopened: false, reopenFailure: (error as Error).message };
  }
}

/** The warning a change carries: none when nothing restarted. */
export function notificationRestartWarnings(
  appBundleId: string,
  outcome: NotificationPermissionOutcome,
): string[] {
  if (!outcome.restarted) return [];
  if (outcome.reopened) {
    return [
      `Restarted SpringBoard to apply the notification permission, and brought ${appBundleId} back to the front because it was running.`,
    ];
  }
  if (outcome.reopenFailure !== undefined) {
    return [
      `${SPRINGBOARD_RESTART_WARNING} Opening ${appBundleId} again failed: ${outcome.reopenFailure}`,
    ];
  }
  return [SPRINGBOARD_RESTART_WARNING];
}

/** `launchctl list` inside the simulator: one `PID Status Label` row per job, `-` for no process. */
async function listJobs({ runSimctl, udid }: NotificationPermissionRequest): Promise<string> {
  return (await runSimctl(['spawn', udid, 'launchctl', 'list'])).stdout;
}

/** The pid of each job that has a process. */
function jobProcesses(list: string): Map<string, number> {
  return new Map(
    readLaunchctlJobs(list).flatMap(({ label, pid }) => (pid === undefined ? [] : [[label, pid]])),
  );
}

/** Polls `launchctl list` until `done` holds, and fails with a typed reason past the bound. */
async function waitForJobs(
  request: NotificationPermissionRequest,
  step: 'stop' | 'start',
  done: (pids: ReadonlyMap<string, number>) => boolean,
): Promise<void> {
  const deadline = Deadline.fromTimeoutMs(SERVICE_WAIT_MS);
  for (;;) {
    if (done(jobProcesses(await listJobs(request)))) return;
    if (deadline.isExpired()) {
      throw new AppError(
        'COMMAND_FAILED',
        step === 'stop'
          ? `iOS simulator SpringBoard or usernotificationsd kept running within ${SERVICE_WAIT_MS / 1000} seconds of launchctl stop.`
          : `iOS simulator SpringBoard did not start within ${SERVICE_WAIT_MS / 1000} seconds.`,
        {
          reason: SIMULATOR_NOTIFICATION_REASONS.restartTimeout.reason,
          deviceId: request.deviceId,
          appBundleId: request.appBundleId,
        },
      );
    }
    await sleep(SERVICE_POLL_MS);
  }
}

/** The status the action leaves, with `null` for a reset's absent record. */
function wantedStatus(action: NotificationPermissionRequest['action']): number | null {
  return action === 'reset' ? null : AUTHORIZATION_STATUS[action];
}

/**
 * The `authorizationStatus` an app's record holds, `null` when it has none, and `undefined` when
 * its archive cannot be read, which never matches a wanted status.
 */
async function recordedStatus(
  file: SettingsFile,
  bundleId: string,
): Promise<number | null | undefined> {
  const record = file.sections[bundleId];
  if (record === undefined) return null;
  const { parseBinary } = await import('plist');
  try {
    const archive = parseBinary(record as Uint8Array) as {
      $top: { root: { UID: number } };
      $objects: Array<Record<string, { UID: number } | number>>;
    };
    const info = archive.$objects[archive.$top.root.UID];
    const settingsRef = info?.sectionInfoSettings;
    const settings =
      typeof settingsRef === 'object' ? archive.$objects[settingsRef.UID] : undefined;
    const status = settings?.authorizationStatus;
    return typeof status === 'number' ? status : undefined;
  } catch {
    return undefined;
  }
}

async function readSettingsFile(
  request: NotificationPermissionRequest,
  settingsPath: string,
): Promise<SettingsFile> {
  let bytes: Uint8Array;
  try {
    bytes = await readHostBinaryFile(settingsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw notificationSettingsError(
      request,
      'missing',
      `iOS simulator has no notification settings file at ${settingsPath}.`,
      'Boot the simulator to the Home Screen once so SpringBoard creates the file, then retry.',
    );
  }
  let plist: Awaited<ReturnType<typeof readApplePlist>> | undefined;
  try {
    plist = await readApplePlist(bytes);
  } catch {
    plist = undefined;
  }
  if (plist && isRecognizedStore(plist.value)) {
    return { format: plist.format, store: plist.value, sections: plist.value.sectionInfo };
  }
  throw notificationSettingsError(
    request,
    'unrecognized',
    `iOS simulator notification settings at ${settingsPath} are not in the layout this command writes (sectionInfoVersionNumber ${SECTION_INFO_VERSION}).`,
    'Answer the app notification prompt instead, or change notifications in the Settings app.',
  );
}

/** Only the two keys SpringBoard writes, so a rewrite cannot change a value it does not know. */
function isRecognizedStore(
  store: PlistValue,
): store is { sectionInfo: Record<string, Uint8Array>; sectionInfoVersionNumber: number } {
  if (!isDictionary(store)) return false;
  const { sectionInfo, sectionInfoVersionNumber, ...rest } = store;
  return (
    Object.keys(rest).length === 0 &&
    sectionInfoVersionNumber === SECTION_INFO_VERSION &&
    isDictionary(sectionInfo) &&
    Object.values(sectionInfo).every((record) => record instanceof Uint8Array)
  );
}

function isDictionary(value: PlistValue | undefined): value is Record<string, PlistValue> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof Date)
  );
}

/** Writes beside the file and renames over it, so a failed write leaves the old settings whole. */
async function writeSettingsFile(settingsPath: string, file: SettingsFile): Promise<void> {
  const { build, buildBinary } = await import('plist');
  const temporaryPath = `${settingsPath}.agent-device.tmp`;
  try {
    await writeHostBinaryFile(
      temporaryPath,
      file.format === 'binary'
        ? buildBinary(file.store)
        : new TextEncoder().encode(build(file.store)),
    );
    await renameHostPath(temporaryPath, settingsPath);
  } catch (error) {
    await removeHostPath(temporaryPath);
    throw error;
  }
}

/** A plist UID, the reference type of an NSKeyedArchiver object table. */
const uid = (index: number): PlistValue => ({ UID: index });

/**
 * The `BBSectionInfo` archive iOS 27 writes after a user answers the prompt. The app's display name
 * is the bundle id, as nothing here reads the installed app's name.
 */
async function sectionInfoArchive(bundleId: string, status: 1 | 2): Promise<Uint8Array> {
  const { buildBinary } = await import('plist');
  const allowed = status === AUTHORIZATION_STATUS.grant;
  const settings = {
    $class: uid(4),
    authorizationStatus: status,
    authorizationExpirationDate: uid(0),
    lastUserGrantedAuthorizationDate: uid(0),
    alertType: 1,
    pushSettings: allowed ? 63 : 0,
    showsInNotificationCenter: allowed,
    showsInLockScreen: allowed,
    showsOnExternalDevices: allowed,
    notificationCenterSetting: allowed ? 2 : 1,
    lockScreenSetting: allowed ? 2 : 1,
    remoteNotificationsSetting: allowed ? 2 : 1,
    carPlaySetting: 0,
    criticalAlertSetting: 0,
    timeSensitiveSetting: 0,
    userConfiguredTimeSensitiveSetting: false,
    directMessagesSettingKey: 0,
    userConfiguredDirectMessagesSetting: false,
    announceSetting: 1,
    announcePriority: 0,
    bulletinGroupingSetting: 0,
    contentPreviewSetting: 0,
    prioritizationSetting: 2,
    summarizationSetting: 2,
    scheduledDeliverySetting: 1,
    showsCustomSettingsLink: false,
    muteAssertion: uid(0),
  };
  const info = {
    $class: uid(10),
    sectionID: uid(2),
    sectionInfoSettings: uid(3),
    lastSettingChangeDate: uid(5),
    appName: uid(7),
    displayName: uid(8),
    version: uid(9),
    lastSettingSource: 2,
    sectionType: 0,
    sectionCategory: 0,
    subsectionPriority: 0,
    suppressFromSettings: false,
    suppressedSettings: 0,
    isRestricted: false,
    isModificationAllowed: false,
    hasEverBeenUserChanged: false,
    isAppClip: false,
    isLocked: false,
    hideWeeApp: false,
    customSettingsBundle: uid(0),
    customSettingsDetailControllerClass: uid(0),
    icon: uid(0),
    subsections: uid(0),
    subsectionID: uid(0),
    managedSectionInfoSettings: uid(0),
    factorySectionID: uid(0),
    dataProviderIDs: uid(0),
    pathToWeeAppPluginBundle: uid(0),
  };
  const objects: PlistValue[] = [
    '$null',
    info,
    bundleId,
    settings,
    { $classname: 'BBSectionInfoSettings', $classes: ['BBSectionInfoSettings', 'NSObject'] },
    { 'NS.time': Date.now() / 1000 - COCOA_EPOCH_SECONDS, $class: uid(6) },
    { $classname: 'NSDate', $classes: ['NSDate', 'NSObject'] },
    bundleId,
    bundleId,
    0,
    { $classname: 'BBSectionInfo', $classes: ['BBSectionInfo', 'NSObject'] },
  ];
  return buildBinary({
    $version: 100_000,
    $archiver: 'NSKeyedArchiver',
    $top: { root: uid(1) },
    $objects: objects,
  });
}

/** The refusals of a settings file this cannot write, which `all` skips; a failed restart is not one. */
const SETTINGS_REFUSALS: readonly string[] = [
  SIMULATOR_NOTIFICATION_REASONS.unreachable.reason,
  SIMULATOR_NOTIFICATION_REASONS.missing.reason,
  SIMULATOR_NOTIFICATION_REASONS.unrecognized.reason,
];

/** Whether an error is the refusal of a settings file this cannot write, which `all` skips. */
export function isNotificationSettingsRefusal(error: unknown): error is AppError {
  return error instanceof AppError && SETTINGS_REFUSALS.includes(String(error.details?.reason));
}

function notificationSettingsError(
  { deviceId, appBundleId }: NotificationPermissionRequest,
  reason: keyof typeof SIMULATOR_NOTIFICATION_REASONS,
  message: string,
  hint: string,
): AppError {
  return new AppError('UNSUPPORTED_OPERATION', message, {
    reason: SIMULATOR_NOTIFICATION_REASONS[reason].reason,
    deviceId,
    appBundleId,
    hint,
  });
}
