import {
  APPLE_BIOMETRIC_LEAF_REFUSAL,
  getUnsupportedMacOsSettingMessage,
  parsePermissionAction,
  parseSettingState,
  type ReadableSetting,
  type ReadSettingResult,
  type SettingOptions,
} from '@agent-device/contracts/settings';
import { isIosFamily, isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import {
  AppError,
  sessionAppRequiredDetails,
  summarizeCommandAttemptFailures,
  type CommandAttemptFailure,
} from '@agent-device/kernel/errors';
import {
  ensureHostDirectory,
  readHostDirectory,
  removeHostPath,
} from '@agent-device/host-kit/host-file';
import path from 'node:path';
import { requireExecSuccess } from '@agent-device/host-kit/command';
import { setMacOsAppearance } from '../os/macos/apps.ts';
import { runMacOsPermissionAction, type MacOsPermissionTarget } from '../os/macos/helper.ts';
import { closeIosApp } from './app-launch.ts';
import { applySimctlSetting } from './simctl-settings.ts';
import { readIosTextSize, setIosTextSize } from './settings-text-size.ts';
import { requireHandheldAppleSimulatorLeaf } from './settings-leaf.ts';
import { resolveIosApp } from './app-resolution.ts';
import { buildSimctlArgsForDevice, runSimctlForDevice } from './simctl.ts';
import {
  invalidateSimulatorStatusBarOverrideCache,
  rememberClearedStatusBarOverrides,
} from './screenshot-status-bar.ts';
import { ensureBootedSimulator, requireSimulatorDevice } from './simulator.ts';
import { runXcrun } from './tool-provider.ts';

// fallow-ignore-next-line complexity
export async function setIosSetting(
  device: DeviceInfo,
  setting: string,
  state: string,
  appBundleId?: string,
  options?: SettingOptions,
): Promise<Record<string, unknown> | void> {
  if (isMacOs(device)) {
    const normalizedSetting = setting.toLowerCase();
    if (normalizedSetting === 'appearance') {
      await setMacOsAppearance(state);
      return;
    }
    if (normalizedSetting === 'permission') {
      const action = parsePermissionAction(state);
      if (action === 'deny') {
        throw new AppError('INVALID_ARGS', getUnsupportedMacOsSettingMessage('permission'));
      }
      const permissionTarget = parseMacOsPermissionTarget(options?.permissionTarget);
      return await runMacOsPermissionAction(action, permissionTarget);
    }
    throw new AppError('INVALID_ARGS', getUnsupportedMacOsSettingMessage(setting));
  }
  requireSimulatorDevice(device, 'settings');
  await ensureBootedSimulator(device);
  const normalized = setting.toLowerCase();

  switch (normalized) {
    case 'clear-app-state': {
      if (state.toLowerCase() !== 'clear') {
        throw new AppError('INVALID_ARGS', 'settings clear-app-state only supports clear.');
      }
      if (!appBundleId) {
        throw new AppError(
          'INVALID_ARGS',
          'settings clear-app-state requires an app id or an active app session.',
          sessionAppRequiredDetails(),
        );
      }
      const result = await clearIosSimulatorAppState(device, appBundleId);
      return { bundleId: result.bundleId, containerPath: result.containerPath, cleared: true };
    }
    case 'reset-keychain': {
      if (state.toLowerCase() !== 'clear') {
        throw new AppError('INVALID_ARGS', 'settings reset-keychain only supports clear.');
      }
      await runSimctlForDevice(device, ['keychain', device.id, 'reset']);
      return {
        scope: 'simulator',
        cleared: true,
        message:
          'Reset the whole iOS simulator keychain. This clears keychain-backed credentials for every installed app, not just the app under test.',
      };
    }
    case 'wifi': {
      const enabled = parseSettingState(state);
      const mode = enabled ? 'active' : 'failed';
      await runSimctlForDevice(device, ['status_bar', device.id, 'override', '--wifiMode', mode]);
      invalidateSimulatorStatusBarOverrideCache(device);
      return;
    }
    case 'airplane': {
      const enabled = parseSettingState(state);
      if (enabled) {
        await runSimctlForDevice(device, [
          'status_bar',
          device.id,
          'override',
          '--dataNetwork',
          'hide',
          '--wifiMode',
          'failed',
          '--wifiBars',
          '0',
          '--cellularMode',
          'failed',
          '--cellularBars',
          '0',
          '--operatorName',
          '',
        ]);
        invalidateSimulatorStatusBarOverrideCache(device);
      } else {
        await runSimctlForDevice(device, ['status_bar', device.id, 'clear']);
        rememberClearedStatusBarOverrides(device);
      }
      return;
    }
    case 'faceid':
    case 'touchid': {
      requireHandheldAppleSimulatorLeaf(device, APPLE_BIOMETRIC_LEAF_REFUSAL);
      const biometricSetting = normalized as IosBiometricSetting;
      const biometric = IOS_BIOMETRIC_SETTINGS[biometricSetting];
      const action = parseBiometricAction(state, biometricSetting);
      await runIosBiometricSimctlCommand(device, action, {
        settingName: biometricSetting,
        notificationModality: biometric.notificationModality,
      });
      return;
    }
    case 'text-size': {
      return await setIosTextSize(device, state);
    }
    case 'appearance':
    case 'permission':
    case 'location':
      return await applySimctlSetting({
        runSimctl: (args) => runSimctlForDevice(device, args),
        udid: device.id,
        deviceId: device.id,
        setting: normalized,
        state,
        appBundleId,
        options,
      });
    default:
      throw new AppError('INVALID_ARGS', `Unsupported setting: ${setting}`);
  }
}

/**
 * The Apple read leg, exhaustive over the readable list: a setting joins `READABLE_SETTINGS` only
 * with an answer here, so a new readable name is a compile error on this map rather than a runtime
 * refusal hidden in a default case. The leaf that holds the value still refuses on its own fact.
 */
const IOS_READABLE_SETTINGS = {
  'text-size': readIosTextSize,
} as const satisfies Record<ReadableSetting, (device: DeviceInfo) => Promise<ReadSettingResult>>;

/** Answers `settings <setting>` with the value the Apple leaf holds. */
export async function readIosSetting(
  device: DeviceInfo,
  setting: ReadableSetting,
): Promise<ReadSettingResult> {
  return await IOS_READABLE_SETTINGS[setting](device);
}

/**
 * Binds a data container to its bundle in the simulator's container manager. It is container
 * identity, not app state: removing it orphans the container until the app is reinstalled.
 */
const CONTAINER_MANAGER_METADATA_FILE = '.com.apple.mobile_container_manager.metadata.plist';

/**
 * The directories a fresh install creates in the data container. iOS does not recreate them on
 * relaunch; without `tmp`, every URLSession download task fails until the app is reinstalled.
 * The list matches the iOS 26.5 fresh-install layout; older runtimes and tvOS or visionOS
 * simulators may differ, but an extra empty directory there is harmless.
 */
const FRESH_INSTALL_DATA_DIRECTORIES = [
  'Documents',
  'Library/Caches',
  'Library/Preferences',
  'SystemData',
  'tmp',
];

async function clearIosSimulatorAppState(
  device: DeviceInfo,
  app: string,
): Promise<{ bundleId: string; containerPath: string }> {
  if (!isIosFamily(device) || device.kind !== 'simulator') {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'Clearing app state is currently supported only on iOS simulators.',
    );
  }

  const bundleId = await resolveIosApp(device, app);
  await ensureBootedSimulator(device);
  await closeIosApp(device, bundleId);

  const result = requireExecSuccess(
    await runSimctlForDevice(device, ['get_app_container', device.id, bundleId, 'data'], {
      allowFailure: true,
    }),
    `simctl get_app_container failed for ${bundleId}`,
  );

  const containerPath = result.stdout.trim();
  if (!containerPath) {
    throw new AppError(
      'COMMAND_FAILED',
      `simctl get_app_container returned an empty data container path for ${bundleId}`,
    );
  }

  const entries = await readHostDirectory(containerPath);
  await Promise.all(
    entries
      .filter((entry) => entry !== CONTAINER_MANAGER_METADATA_FILE)
      .map((entry) => removeHostPath(path.join(containerPath, entry))),
  );
  await Promise.all(
    FRESH_INSTALL_DATA_DIRECTORIES.map((directory) =>
      ensureHostDirectory(path.join(containerPath, directory)),
    ),
  );

  return { bundleId, containerPath };
}

function parseMacOsPermissionTarget(value: string | undefined): MacOsPermissionTarget {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === 'accessibility' ||
    normalized === 'screen-recording' ||
    normalized === 'input-monitoring'
  ) {
    return normalized;
  }
  throw new AppError(
    'INVALID_ARGS',
    'Unsupported macOS permission target. Use accessibility|screen-recording|input-monitoring.',
  );
}

type IosBiometricAction = 'match' | 'nonmatch' | 'enroll' | 'unenroll';
type IosBiometricSetting = 'faceid' | 'touchid';

/** The BiometricKit_Sim notification family a setting posts to: `pearl` is Face ID, `fingerTouch` is Touch ID. */
type IosBiometricNotificationModality = 'pearl' | 'fingerTouch';

const IOS_BIOMETRIC_SETTINGS: Record<
  IosBiometricSetting,
  { notificationModality: IosBiometricNotificationModality }
> = {
  faceid: { notificationModality: 'pearl' },
  touchid: { notificationModality: 'fingerTouch' },
};

function parseBiometricAction(state: string, settingName: IosBiometricSetting): IosBiometricAction {
  const normalized = state.trim().toLowerCase();
  if (normalized === 'match') return 'match';
  if (normalized === 'nonmatch') return 'nonmatch';
  if (normalized === 'enroll') return 'enroll';
  if (normalized === 'unenroll') return 'unenroll';
  throw new AppError(
    'INVALID_ARGS',
    `Invalid ${settingName} state: ${state}. Use match|nonmatch|enroll|unenroll.`,
  );
}

/**
 * Simulator biometrics are driven the way the Simulator.app menu drives them: `notifyutil` inside
 * the simulator posts to `com.apple.BiometricKit_Sim` for a match or non-match and flips the
 * `enrollmentChanged` state for enrollment. No shipped Xcode has a `simctl biometric` subcommand.
 */
async function runIosBiometricSimctlCommand(
  device: DeviceInfo,
  action: IosBiometricAction,
  options: {
    settingName: IosBiometricSetting;
    notificationModality: IosBiometricNotificationModality;
  },
): Promise<void> {
  const args = buildSimctlArgsForDevice(
    device,
    biometricNotifyutilArgs(device.id, action, options.notificationModality),
  );
  const result = await runXcrun(args, { allowFailure: true });
  const failures: CommandAttemptFailure[] = [];
  if (result.exitCode !== 0) {
    failures.push({
      args,
      stderr: result.stderr,
      stdout: result.stdout,
      exitCode: result.exitCode,
    });
  } else {
    const expected = enrollmentStateFor(action);
    if (expected !== undefined) {
      const readBack = await readBiometricEnrollmentState(device);
      if (readBack.state === expected) return;
      failures.push({
        args: readBack.args,
        stderr: readBack.stderr,
        stdout: readBack.stdout,
        exitCode: readBack.exitCode,
      });
    } else {
      return;
    }
  }
  throw new AppError('COMMAND_FAILED', `Failed to simulate ${options.settingName}.`, {
    deviceId: device.id,
    action,
    setting: options.settingName,
    attempts: summarizeCommandAttemptFailures(failures),
  });
}

const BIOMETRIC_ENROLLMENT_NOTIFICATION = 'com.apple.BiometricKit.enrollmentChanged';

function enrollmentStateFor(action: IosBiometricAction): '1' | '0' | undefined {
  if (action === 'enroll') return '1';
  if (action === 'unenroll') return '0';
  return undefined;
}

/**
 * Reads the enrollment state BiometricKit holds after an enroll or unenroll post, so a post that
 * exited 0 without landing is a failure rather than an "Updated setting". `notifyutil -g` answers
 * `<name> <state>` on one line.
 */
async function readBiometricEnrollmentState(
  device: DeviceInfo,
): Promise<CommandAttemptFailure & { state: string | undefined }> {
  const args = buildSimctlArgsForDevice(device, [
    'spawn',
    device.id,
    'notifyutil',
    '-g',
    BIOMETRIC_ENROLLMENT_NOTIFICATION,
  ]);
  const result = await runXcrun(args, { allowFailure: true });
  const state = result.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[0] === BIOMETRIC_ENROLLMENT_NOTIFICATION)?.[1];
  return {
    args,
    stderr: result.stderr,
    stdout: result.stdout,
    exitCode: result.exitCode,
    state: result.exitCode === 0 ? state : undefined,
  };
}

/**
 * The `simctl spawn <udid> notifyutil` argv for one biometric action; enrollment sets the state
 * before posting so BiometricKit reads the new value when the notification lands.
 */
function biometricNotifyutilArgs(
  deviceId: string,
  action: IosBiometricAction,
  modality: IosBiometricNotificationModality,
): string[] {
  const spawn = ['spawn', deviceId, 'notifyutil'];
  switch (action) {
    case 'match':
      return [...spawn, '-p', `com.apple.BiometricKit_Sim.${modality}.match`];
    case 'nonmatch':
      return [...spawn, '-p', `com.apple.BiometricKit_Sim.${modality}.nomatch`];
    case 'enroll':
      return [
        ...spawn,
        '-s',
        BIOMETRIC_ENROLLMENT_NOTIFICATION,
        '1',
        '-p',
        BIOMETRIC_ENROLLMENT_NOTIFICATION,
      ];
    case 'unenroll':
      return [
        ...spawn,
        '-s',
        BIOMETRIC_ENROLLMENT_NOTIFICATION,
        '0',
        '-p',
        BIOMETRIC_ENROLLMENT_NOTIFICATION,
      ];
  }
}
