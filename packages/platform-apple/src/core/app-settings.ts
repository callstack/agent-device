import {
  getUnsupportedMacOsSettingMessage,
  type MobilePermissionTarget,
  parseAppearanceAction,
  parsePermissionAction,
  parsePermissionTarget,
  parseSettingState,
  type ReadableSetting,
  type ReadSettingResult,
  type SettingOptions,
} from '@agent-device/contracts/settings';
import { isIosFamily, isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import {
  AppError,
  summarizeCommandAttemptFailures,
  type CommandAttemptFailure,
} from '@agent-device/kernel/errors';
import { readHostDirectory, removeHostPath } from '@agent-device/host-kit/host-file';
import path from 'node:path';
import { requireExecSuccess } from '@agent-device/host-kit/command';
import { requireLocationCoordinates } from '@agent-device/kernel/location-coordinates';
import { setMacOsAppearance } from '../os/macos/apps.ts';
import { runMacOsPermissionAction, type MacOsPermissionTarget } from '../os/macos/helper.ts';
import { closeIosApp } from './app-launch.ts';
import { readIosTextSize, setIosTextSize } from './settings-text-size.ts';
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
    case 'location': {
      if (state.toLowerCase() === 'set') {
        const { latitude, longitude } = requireLocationCoordinates(options);
        await runSimctlForDevice(device, [
          'location',
          device.id,
          'set',
          `${latitude},${longitude}`,
        ]);
        return { latitude, longitude };
      }
      const enabled = parseSettingState(state);
      if (!appBundleId) {
        throw new AppError('INVALID_ARGS', 'location setting requires an active app in session');
      }
      const action = enabled ? 'grant' : 'revoke';
      await runSimctlForDevice(device, ['privacy', device.id, action, 'location', appBundleId]);
      return;
    }
    case 'faceid':
    case 'touchid': {
      const biometricSetting = normalized as IosBiometricSetting;
      const biometric = IOS_BIOMETRIC_SETTINGS[biometricSetting];
      const action = parseBiometricAction(state, biometricSetting);
      await runIosBiometricSimctlCommand(device, action, {
        settingName: biometricSetting,
        notificationModality: biometric.notificationModality,
      });
      return;
    }
    case 'appearance': {
      const target = await resolveIosAppearanceTarget(device, state);
      await runSimctlForDevice(device, ['ui', device.id, 'appearance', target]);
      return;
    }
    case 'text-size': {
      return await setIosTextSize(device, state);
    }
    case 'permission': {
      if (!appBundleId) {
        throw new AppError('INVALID_ARGS', 'permission setting requires an active app in session');
      }
      const action = mapIosPermissionAction(parsePermissionAction(state));
      const target = parseIosPermissionTarget(options?.permissionTarget, options?.permissionMode);
      await runIosPrivacyCommand(device, action, target, appBundleId);
      return;
    }
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
  await Promise.all(entries.map((entry) => removeHostPath(path.join(containerPath, entry))));

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

async function resolveIosAppearanceTarget(
  device: DeviceInfo,
  state: string,
): Promise<'light' | 'dark'> {
  const action = parseAppearanceAction(state);
  if (action !== 'toggle') return action;

  const currentResult = requireExecSuccess(
    await runSimctlForDevice(device, ['ui', device.id, 'appearance'], {
      allowFailure: true,
    }),
    'Failed to read current iOS appearance',
  );
  const current = parseIosAppearance(currentResult.stdout, currentResult.stderr);
  if (!current) {
    throw new AppError('COMMAND_FAILED', 'Unable to determine current iOS appearance for toggle', {
      stdout: currentResult.stdout,
      stderr: currentResult.stderr,
    });
  }
  return current === 'dark' ? 'light' : 'dark';
}

function parseIosAppearance(stdout: string, stderr: string): 'light' | 'dark' | null {
  const match = /\b(light|dark|unsupported|unknown)\b/i.exec(`${stdout}\n${stderr}`);
  if (!match) return null;
  const value = match[1]?.toLowerCase();
  if (value === 'dark') return 'dark';
  if (value === 'light') return 'light';
  return null;
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

function mapIosPermissionAction(action: 'grant' | 'deny' | 'reset'): 'grant' | 'revoke' | 'reset' {
  if (action === 'deny') return 'revoke';
  return action;
}

async function runIosPrivacyCommand(
  device: DeviceInfo,
  action: 'grant' | 'revoke' | 'reset',
  target: string,
  appBundleId: string,
): Promise<void> {
  try {
    await runSimctlForDevice(device, ['privacy', device.id, action, target, appBundleId]);
  } catch (error) {
    if (!isPrivacyServiceRefusedError(error)) throw error;
    throw privacyServiceRefusedError(device, action, target, appBundleId, error);
  }
}

/**
 * `simctl privacy` is its own capability check: a service the runtime cannot change answers
 * EPERM, whether or not it is spelled in the help text. The help text is not a capability
 * list — Xcode 26 omits `camera`, which it does change — so the verdict is read from the
 * command that would have made the change rather than from a probe that can only guess.
 */
function isPrivacyServiceRefusedError(error: unknown): boolean {
  if (!(error instanceof AppError) || error.code !== 'COMMAND_FAILED') return false;
  const stderr = String(error.details?.stderr ?? '').toLowerCase();
  return (
    /failed to (set|grant|revoke|reset) access/.test(stderr) &&
    stderr.includes('operation not permitted')
  );
}

function privacyServiceRefusedError(
  device: DeviceInfo,
  action: 'grant' | 'revoke' | 'reset',
  target: string,
  appBundleId: string,
  cause: unknown,
): AppError {
  if (action === 'reset') {
    return new AppError(
      'UNSUPPORTED_OPERATION',
      `iOS simulator does not support resetting ${target} permission via simctl privacy on this runtime.`,
      {
        deviceId: device.id,
        appBundleId,
        hint: 'Use reinstall to force a fresh prompt, or reset simulator content and settings.',
      },
      cause,
    );
  }
  return new AppError(
    'UNSUPPORTED_OPERATION',
    `iOS simulator does not support setting ${target} permission via simctl privacy on this runtime.`,
    {
      deviceId: device.id,
      appBundleId,
      hint: 'Privacy support varies by Xcode runtime: run `xcrun simctl privacy help` for its documented services, or use the `all` target, which applies the action to every service this runtime can change.',
    },
    cause,
  );
}

/** The `simctl privacy` service for every target except `photos`, whose service depends on its mode. */
const IOS_PRIVACY_SERVICES: Record<Exclude<MobilePermissionTarget, 'photos'>, string> = {
  all: 'all',
  camera: 'camera',
  microphone: 'microphone',
  contacts: 'contacts',
  'contacts-limited': 'contacts-limited',
  notifications: 'notifications',
  calendar: 'calendar',
  location: 'location',
  'location-always': 'location-always',
  'media-library': 'media-library',
  motion: 'motion',
  reminders: 'reminders',
  siri: 'siri',
};

function parseIosPermissionTarget(
  permissionTarget: string | undefined,
  permissionMode: string | undefined,
): string {
  const normalized = parsePermissionTarget(permissionTarget);
  if (normalized === 'photos') {
    const mode = permissionMode?.trim().toLowerCase();
    if (!mode || mode === 'full') return 'photos';
    if (mode === 'limited') return 'photos-add';
    throw new AppError('INVALID_ARGS', `Invalid photos mode: ${permissionMode}. Use full|limited.`);
  }
  if (permissionMode?.trim()) {
    throw new AppError(
      'INVALID_ARGS',
      `Permission mode is only supported for photos. Received: ${permissionMode}.`,
    );
  }
  return IOS_PRIVACY_SERVICES[normalized];
}

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
  if (result.exitCode === 0) return;
  const failure: CommandAttemptFailure = {
    args,
    stderr: result.stderr,
    stdout: result.stdout,
    exitCode: result.exitCode,
  };
  throw new AppError('COMMAND_FAILED', `Failed to simulate ${options.settingName}.`, {
    deviceId: device.id,
    action,
    setting: options.settingName,
    attempts: summarizeCommandAttemptFailures([failure]),
  });
}

const BIOMETRIC_ENROLLMENT_NOTIFICATION = 'com.apple.BiometricKit.enrollmentChanged';

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
