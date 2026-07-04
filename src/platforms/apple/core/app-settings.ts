import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isIosFamily, isMacOs, type DeviceInfo } from '../../../kernel/device.ts';
import { AppError } from '../../../kernel/errors.ts';
import { requireLocationCoordinates } from '../../../utils/location-coordinates.ts';
import { execFailureDetails } from '../../../utils/exec.ts';
import { resolveIosSimulatorDeviceSetPath } from '../../../utils/device-isolation.ts';
import { getUnsupportedMacOsSettingMessage } from '../../../core/settings-contract.ts';
import {
  parsePermissionAction,
  parsePermissionTarget,
  type SettingOptions,
} from '../../permission-utils.ts';
import { parseAppearanceAction } from '../../appearance.ts';
import { parseSettingState } from '../../setting-state.ts';
import {
  summarizeCommandAttemptFailures,
  type CommandAttemptFailure,
} from '../../command-attempts.ts';
import { ensureBootedSimulator, requireSimulatorDevice } from './simulator.ts';
import { runXcrun } from './tool-provider.ts';
import { setMacOsAppearance } from '../os/macos/apps.ts';
import { runMacOsPermissionAction, type MacOsPermissionTarget } from '../os/macos/helper.ts';
import {
  invalidateSimulatorStatusBarOverrideCache,
  rememberClearedStatusBarOverrides,
} from './screenshot-status-bar.ts';
import { closeIosApp } from './app-launch.ts';
import { resolveIosApp } from './app-resolution.ts';
import { runSimctl, simctlArgs } from './apps-simctl.ts';

let cachedSimctlPrivacyServices: Set<string> | null = null;
let cachedSimctlPrivacyServicesCacheKey: string | undefined;

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
    case 'wifi': {
      const enabled = parseSettingState(state);
      const mode = enabled ? 'active' : 'failed';
      await runSimctl(device, ['status_bar', device.id, 'override', '--wifiMode', mode]);
      invalidateSimulatorStatusBarOverrideCache(device);
      return;
    }
    case 'airplane': {
      const enabled = parseSettingState(state);
      if (enabled) {
        await runSimctl(device, [
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
        await runSimctl(device, ['status_bar', device.id, 'clear']);
        rememberClearedStatusBarOverrides(device);
      }
      return;
    }
    case 'location': {
      if (state.toLowerCase() === 'set') {
        const { latitude, longitude } = requireLocationCoordinates(options);
        await runSimctl(device, ['location', device.id, 'set', `${latitude},${longitude}`]);
        return { latitude, longitude };
      }
      const enabled = parseSettingState(state);
      if (!appBundleId) {
        throw new AppError('INVALID_ARGS', 'location setting requires an active app in session');
      }
      const action = enabled ? 'grant' : 'revoke';
      await runSimctl(device, ['privacy', device.id, action, 'location', appBundleId]);
      return;
    }
    case 'faceid':
    case 'touchid': {
      const biometricSetting = normalized as IosBiometricSetting;
      const biometric = IOS_BIOMETRIC_SETTINGS[biometricSetting];
      const action = parseBiometricAction(state, biometricSetting);
      await runIosBiometricSimctlCommand(device, action, {
        settingName: biometricSetting,
        label: biometric.label,
        modalityAliases: biometric.modalityAliases,
      });
      return;
    }
    case 'appearance': {
      const target = await resolveIosAppearanceTarget(device, state);
      await runSimctl(device, ['ui', device.id, 'appearance', target]);
      return;
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

  const result = await runSimctl(device, ['get_app_container', device.id, bundleId, 'data'], {
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    throw new AppError(
      'COMMAND_FAILED',
      `simctl get_app_container failed for ${bundleId}`,
      execFailureDetails(result),
    );
  }

  const containerPath = result.stdout.trim();
  if (!containerPath) {
    throw new AppError(
      'COMMAND_FAILED',
      `simctl get_app_container returned an empty data container path for ${bundleId}`,
    );
  }

  const entries = await fs.readdir(containerPath);
  await Promise.all(
    entries.map((entry) =>
      fs.rm(path.join(containerPath, entry), {
        recursive: true,
        force: true,
      }),
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

async function resolveIosAppearanceTarget(
  device: DeviceInfo,
  state: string,
): Promise<'light' | 'dark'> {
  const action = parseAppearanceAction(state);
  if (action !== 'toggle') return action;

  const currentResult = await runSimctl(device, ['ui', device.id, 'appearance'], {
    allowFailure: true,
  });
  if (currentResult.exitCode !== 0) {
    throw new AppError(
      'COMMAND_FAILED',
      'Failed to read current iOS appearance',
      execFailureDetails(currentResult),
    );
  }
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

const IOS_BIOMETRIC_SETTINGS: Record<
  IosBiometricSetting,
  { label: 'Face ID' | 'Touch ID'; modalityAliases: string[] }
> = {
  faceid: { label: 'Face ID', modalityAliases: ['face'] },
  touchid: { label: 'Touch ID', modalityAliases: ['finger', 'touch'] },
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
  const supportedServices = await getSimctlPrivacyServices(device);
  if (!supportedServices.has(target)) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `iOS simctl privacy does not support service "${target}" on this runtime.`,
      {
        deviceId: device.id,
        appBundleId,
        hint: `Supported services: ${Array.from(supportedServices).sort().join(', ')}`,
      },
    );
  }

  const args = ['privacy', device.id, action, target, appBundleId];
  const isNotificationsTarget = target === 'notifications';
  if (!(action === 'reset' && isNotificationsTarget)) {
    try {
      await runSimctl(device, args);
      return;
    } catch (error) {
      if (!(isNotificationsTarget && isNotificationsOperationNotPermitted(error))) {
        throw error;
      }
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'iOS simulator does not support setting notifications permission via simctl privacy on this runtime.',
        {
          deviceId: device.id,
          appBundleId,
          hint: 'Use reset notifications for reprompt behavior, or toggle notifications manually in Settings.',
        },
      );
    }
  }

  try {
    await runSimctl(device, args);
    return;
  } catch (error) {
    if (!isNotificationsOperationNotPermitted(error)) {
      throw error;
    }
  }

  try {
    await runSimctl(device, ['privacy', device.id, 'reset', 'all', appBundleId]);
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      'iOS simulator blocked direct notifications reset. Fallback reset-all also failed.',
      {
        deviceId: device.id,
        appBundleId,
        hint: 'Use reinstall to force a fresh notifications prompt, or reset simulator content and settings.',
      },
      error instanceof Error ? error : undefined,
    );
  }
}

function isNotificationsOperationNotPermitted(error: unknown): boolean {
  if (!(error instanceof AppError) || error.code !== 'COMMAND_FAILED') return false;
  const stderr = String(error.details?.stderr ?? '').toLowerCase();
  return (
    (stderr.includes('failed to grant access') ||
      stderr.includes('failed to revoke access') ||
      stderr.includes('failed to reset access')) &&
    stderr.includes('operation not permitted')
  );
}

async function getSimctlPrivacyServices(device: DeviceInfo): Promise<Set<string>> {
  const simulatorSetPath = resolveIosSimulatorDeviceSetPath(device.simulatorSetPath);
  const currentCacheKey = `${process.env.PATH ?? ''}::${simulatorSetPath ?? ''}`;
  if (cachedSimctlPrivacyServices && cachedSimctlPrivacyServicesCacheKey === currentCacheKey) {
    return cachedSimctlPrivacyServices;
  }
  const result = await runSimctl(device, ['privacy', 'help'], { allowFailure: true });
  const services = parseSimctlPrivacyServices(`${result.stdout}\n${result.stderr}`);
  if (services.size === 0) {
    throw new AppError('COMMAND_FAILED', 'Unable to determine supported simctl privacy services', {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      hint: 'Run `xcrun simctl privacy help` manually to verify available services for this runtime.',
    });
  }
  cachedSimctlPrivacyServices = services;
  cachedSimctlPrivacyServicesCacheKey = currentCacheKey;
  return services;
}

function parseSimctlPrivacyServices(helpText: string): Set<string> {
  const services = new Set<string>();
  let inServiceSection = false;
  for (const line of helpText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === 'service') {
      inServiceSection = true;
      continue;
    }
    if (!inServiceSection) continue;
    if (trimmed.startsWith('bundle identifier')) break;
    const match = /^([a-z-]+)\s+-\s+/.exec(trimmed);
    const service = match?.[1];
    if (service !== undefined) {
      services.add(service);
    }
  }
  return services;
}

// fallow-ignore-next-line complexity
function parseIosPermissionTarget(
  permissionTarget: string | undefined,
  permissionMode: string | undefined,
): string {
  const normalized = parsePermissionTarget(permissionTarget);
  if (normalized !== 'photos' && permissionMode?.trim()) {
    throw new AppError(
      'INVALID_ARGS',
      `Permission mode is only supported for photos. Received: ${permissionMode}.`,
    );
  }
  if (normalized === 'camera') return 'camera';
  if (normalized === 'microphone') return 'microphone';
  if (normalized === 'contacts') return 'contacts';
  if (normalized === 'contacts-limited') return 'contacts-limited';
  if (normalized === 'notifications') return 'notifications';
  if (normalized === 'calendar') return 'calendar';
  if (normalized === 'location') return 'location';
  if (normalized === 'location-always') return 'location-always';
  if (normalized === 'media-library') return 'media-library';
  if (normalized === 'motion') return 'motion';
  if (normalized === 'reminders') return 'reminders';
  if (normalized === 'siri') return 'siri';
  if (normalized === 'photos') {
    const mode = permissionMode?.trim().toLowerCase();
    if (!mode || mode === 'full') return 'photos';
    if (mode === 'limited') return 'photos-add';
    throw new AppError('INVALID_ARGS', `Invalid photos mode: ${permissionMode}. Use full|limited.`);
  }
  throw new AppError(
    'INVALID_ARGS',
    `Unsupported permission target: ${permissionTarget}. Use camera|microphone|photos|contacts|contacts-limited|notifications|calendar|location|location-always|media-library|motion|reminders|siri.`,
  );
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

async function runIosBiometricSimctlCommand(
  device: DeviceInfo,
  action: IosBiometricAction,
  options: {
    settingName: IosBiometricSetting;
    label: 'Face ID' | 'Touch ID';
    modalityAliases: string[];
  },
): Promise<void> {
  const attempts = biometricCommandAttempts(device.id, action, options.modalityAliases);
  const failures: CommandAttemptFailure[] = [];

  for (const args of attempts) {
    const commandArgs = simctlArgs(device, args);
    const result = await runXcrun(commandArgs, { allowFailure: true });
    if (result.exitCode === 0) return;
    failures.push({
      args: commandArgs,
      stderr: result.stderr,
      stdout: result.stdout,
      exitCode: result.exitCode,
    });
  }

  const attemptsPayload = summarizeCommandAttemptFailures(failures);
  const capabilityMissing =
    failures.length > 0 &&
    failures.every((failure) => isIosBiometricCapabilityMissing(failure.stdout, failure.stderr));
  if (capabilityMissing) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `${options.label} simulation is not supported on this simulator runtime.`,
      {
        deviceId: device.id,
        action,
        setting: options.settingName,
        attempts: attemptsPayload,
      },
    );
  }
  throw new AppError('COMMAND_FAILED', `Failed to simulate ${options.settingName}.`, {
    deviceId: device.id,
    action,
    setting: options.settingName,
    attempts: attemptsPayload,
  });
}

function biometricCommandAttempts(
  deviceId: string,
  action: IosBiometricAction,
  modalityAliases: string[],
): string[][] {
  const modalities = modalityAliases.length > 0 ? modalityAliases : ['face'];
  switch (action) {
    case 'match':
      return modalities.flatMap((modality) => [
        ['biometric', deviceId, 'match', modality],
        ['biometric', 'match', deviceId, modality],
      ]);
    case 'nonmatch':
      return modalities.flatMap((modality) => [
        ['biometric', deviceId, 'nonmatch', modality],
        ['biometric', deviceId, 'nomatch', modality],
        ['biometric', 'nonmatch', deviceId, modality],
        ['biometric', 'nomatch', deviceId, modality],
      ]);
    case 'enroll':
      return [
        ['biometric', deviceId, 'enroll', 'yes'],
        ['biometric', deviceId, 'enroll', '1'],
        ['biometric', 'enroll', deviceId, 'yes'],
        ['biometric', 'enroll', deviceId, '1'],
      ];
    case 'unenroll':
      return [
        ['biometric', deviceId, 'enroll', 'no'],
        ['biometric', deviceId, 'enroll', '0'],
        ['biometric', 'enroll', deviceId, 'no'],
        ['biometric', 'enroll', deviceId, '0'],
      ];
  }
}

function isIosBiometricCapabilityMissing(stdout: string, stderr: string): boolean {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  return (
    text.includes('unrecognized subcommand') ||
    text.includes('unknown subcommand') ||
    text.includes('not supported') ||
    text.includes('unavailable') ||
    (text.includes('biometric') && text.includes('invalid'))
  );
}
