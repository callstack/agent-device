import { AppError } from '../../kernel/errors.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import { requireLocationCoordinates } from '../../utils/location-coordinates.ts';
import {
  summarizeCommandAttemptFailures,
  type CommandAttemptFailure,
} from '../command-attempts.ts';
import {
  parsePermissionAction,
  parsePermissionTarget,
  type SettingOptions,
} from '../permission-utils.ts';
import { parseAppearanceAction } from '../appearance.ts';
import { parseSettingState } from '../setting-state.ts';
import { runAndroidAdb } from './adb.ts';
import { androidAdbResultError } from './adb-executor.ts';
import { resolveAndroidApp } from './app-lifecycle.ts';

const ANDROID_ANIMATION_SCALE_SETTINGS = [
  'window_animation_scale',
  'transition_animation_scale',
  'animator_duration_scale',
] as const;

// fallow-ignore-next-line complexity
export async function setAndroidSetting(
  device: DeviceInfo,
  setting: string,
  state: string,
  appPackage?: string,
  options?: SettingOptions,
): Promise<Record<string, unknown> | void> {
  const normalized = setting.toLowerCase();
  switch (normalized) {
    case 'wifi': {
      const enabled = parseSettingState(state);
      await runAndroidAdb(device, ['shell', 'svc', 'wifi', enabled ? 'enable' : 'disable']);
      return;
    }
    case 'airplane': {
      const enabled = parseSettingState(state);
      const flag = enabled ? '1' : '0';
      const bool = enabled ? 'true' : 'false';
      await runAndroidAdb(device, ['shell', 'settings', 'put', 'global', 'airplane_mode_on', flag]);
      await runAndroidAdb(device, [
        'shell',
        'am',
        'broadcast',
        '-a',
        'android.intent.action.AIRPLANE_MODE',
        '--ez',
        'state',
        bool,
      ]);
      return;
    }
    case 'location': {
      if (state.toLowerCase() === 'set') {
        if (device.kind !== 'emulator') {
          throw new AppError(
            'UNSUPPORTED_OPERATION',
            'Android precise location coordinates are supported only on emulators.',
            {
              deviceId: device.id,
              hint: 'Use an Android emulator for adb emu geo fix, or configure location through device/provider tooling.',
            },
          );
        }
        const { latitude, longitude } = requireLocationCoordinates(options);
        await runAndroidAdb(device, ['emu', 'geo', 'fix', String(longitude), String(latitude)]);
        return { latitude, longitude };
      }
      const enabled = parseSettingState(state);
      const mode = enabled ? '3' : '0';
      await runAndroidAdb(device, ['shell', 'settings', 'put', 'secure', 'location_mode', mode]);
      return;
    }
    case 'animations': {
      const enabled = parseSettingState(state);
      const scale = enabled ? '1' : '0';
      for (const key of ANDROID_ANIMATION_SCALE_SETTINGS) {
        await runAndroidAdb(device, ['shell', 'settings', 'put', 'global', key, scale]);
      }
      return { scale, keys: [...ANDROID_ANIMATION_SCALE_SETTINGS] };
    }
    case 'appearance': {
      const target = await resolveAndroidAppearanceTarget(device, state);
      await runAndroidAdb(device, [
        'shell',
        'cmd',
        'uimode',
        'night',
        target === 'dark' ? 'yes' : 'no',
      ]);
      return;
    }
    case 'clear-app-state': {
      if (state.toLowerCase() !== 'clear') {
        throw new AppError('INVALID_ARGS', 'settings clear-app-state only supports clear.');
      }
      if (!appPackage) {
        throw new AppError(
          'INVALID_ARGS',
          'settings clear-app-state requires an app id or an active app session.',
        );
      }
      const resolved = await resolveAndroidApp(device, appPackage);
      if (resolved.type === 'intent') {
        throw new AppError(
          'INVALID_ARGS',
          'settings clear-app-state requires a package name, not an intent.',
        );
      }
      await runAndroidAdb(device, ['shell', 'am', 'force-stop', resolved.value], {
        allowFailure: true,
      });
      const result = await runAndroidAdb(device, ['shell', 'pm', 'clear', resolved.value], {
        allowFailure: true,
      });
      if (result.exitCode !== 0 || !/\bSuccess\b/i.test(result.stdout)) {
        // exec-guard-allow: pm clear can exit 0 without printing Success; the
        // guard also covers that non-exit failure mode.
        throw new AppError(
          'COMMAND_FAILED',
          `Failed to clear Android app data for ${resolved.value}`,
          {
            package: resolved.value,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
          },
        );
      }
      return { package: resolved.value, cleared: true };
    }
    case 'fingerprint': {
      const action = parseAndroidFingerprintAction(state);
      await runAndroidFingerprintCommand(device, action);
      return;
    }
    case 'permission': {
      if (!appPackage) {
        throw new AppError('INVALID_ARGS', 'permission setting requires an active app in session');
      }
      const action = parsePermissionAction(state);
      const target = parseAndroidPermissionTarget(
        options?.permissionTarget,
        options?.permissionMode,
      );
      if (target.kind === 'notifications') {
        await setAndroidNotificationPermission(device, appPackage, action, target);
        return;
      }
      const pmAction = action === 'grant' ? 'grant' : 'revoke';
      if (target.type === 'photos') {
        await setAndroidPhotoPermission(device, appPackage, pmAction);
        return;
      }
      await runAndroidAdb(device, ['shell', 'pm', pmAction, appPackage, target.value]);
      return;
    }
    default:
      throw new AppError('INVALID_ARGS', `Unsupported setting: ${setting}`);
  }
}

type AndroidFingerprintAction = 'match' | 'nonmatch';

function parseAndroidFingerprintAction(state: string): AndroidFingerprintAction {
  const normalized = state.trim().toLowerCase();
  if (normalized === 'match') return 'match';
  if (normalized === 'nonmatch') return 'nonmatch';
  throw new AppError('INVALID_ARGS', `Invalid fingerprint state: ${state}. Use match|nonmatch.`);
}

async function runAndroidFingerprintCommand(
  device: DeviceInfo,
  action: AndroidFingerprintAction,
): Promise<void> {
  const attempts = androidFingerprintCommandAttempts(device, action);
  const failures: CommandAttemptFailure[] = [];

  for (const args of attempts) {
    const result = await runAndroidAdb(device, args, { allowFailure: true });
    if (result.exitCode === 0) return;
    failures.push({
      args,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }

  const attemptsPayload = summarizeCommandAttemptFailures(failures);
  const capabilityMissing =
    failures.length > 0 &&
    failures.every((failure) =>
      isAndroidFingerprintCapabilityMissing(failure.stdout, failure.stderr),
    );
  if (capabilityMissing) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'Android fingerprint simulation is not supported on this target/runtime.',
      {
        deviceId: device.id,
        action,
        hint: 'Use an Android emulator with biometric support, or a device/runtime that exposes cmd fingerprint.',
        attempts: attemptsPayload,
      },
    );
  }
  throw new AppError('COMMAND_FAILED', 'Failed to simulate Android fingerprint.', {
    deviceId: device.id,
    action,
    attempts: attemptsPayload,
  });
}

function androidFingerprintCommandAttempts(
  device: DeviceInfo,
  action: AndroidFingerprintAction,
): string[][] {
  const fingerprintId = action === 'match' ? '1' : '9999';
  const attempts: string[][] = [
    ['shell', 'cmd', 'fingerprint', 'touch', fingerprintId],
    ['shell', 'cmd', 'fingerprint', 'finger', fingerprintId],
  ];
  if (device.kind === 'emulator') {
    attempts.push(['emu', 'finger', 'touch', fingerprintId]);
  }
  return attempts;
}

function isAndroidFingerprintCapabilityMissing(stdout: string, stderr: string): boolean {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  return (
    text.includes('unknown command') ||
    text.includes("can't find service: fingerprint") ||
    text.includes('service fingerprint was not found') ||
    text.includes('fingerprint cmd unavailable') ||
    text.includes('emu command is not supported') ||
    text.includes('emulator console is not running') ||
    (text.includes('fingerprint') && text.includes('not found'))
  );
}

async function resolveAndroidAppearanceTarget(
  device: DeviceInfo,
  state: string,
): Promise<'light' | 'dark'> {
  const action = parseAppearanceAction(state);
  if (action !== 'toggle') return action;

  const currentResult = await runAndroidAdb(device, ['shell', 'cmd', 'uimode', 'night'], {
    allowFailure: true,
  });
  if (currentResult.exitCode !== 0) {
    throw androidAdbResultError('Failed to read current Android appearance', currentResult);
  }
  const current = parseAndroidAppearance(currentResult.stdout, currentResult.stderr);
  if (!current) {
    throw new AppError(
      'COMMAND_FAILED',
      'Unable to determine current Android appearance for toggle',
      {
        stdout: currentResult.stdout,
        stderr: currentResult.stderr,
      },
    );
  }
  if (current === 'auto') return 'dark';
  return current === 'dark' ? 'light' : 'dark';
}

function parseAndroidAppearance(stdout: string, stderr: string): 'light' | 'dark' | 'auto' | null {
  const match = /night mode:\s*(yes|no|auto)\b/i.exec(`${stdout}\n${stderr}`);
  if (!match) return null;
  const value = match[1]?.toLowerCase();
  if (value === 'yes') return 'dark';
  if (value === 'no') return 'light';
  if (value === 'auto') return 'auto';
  return null;
}

function parseAndroidPermissionTarget(
  permissionTarget: string | undefined,
  permissionMode: string | undefined,
):
  | { kind: 'pm'; value: string; type: 'camera' | 'microphone' | 'photos' | 'contacts' }
  | { kind: 'notifications'; appOps: string; permission: string } {
  const normalized = parsePermissionTarget(permissionTarget);
  if (permissionMode?.trim()) {
    throw new AppError(
      'INVALID_ARGS',
      `Permission mode is only supported for photos. Received: ${permissionMode}.`,
    );
  }
  if (normalized === 'camera')
    return { kind: 'pm', value: 'android.permission.CAMERA', type: 'camera' };
  if (normalized === 'microphone') {
    return { kind: 'pm', value: 'android.permission.RECORD_AUDIO', type: 'microphone' };
  }
  if (normalized === 'photos') {
    return { kind: 'pm', value: 'android.permission.READ_MEDIA_IMAGES', type: 'photos' };
  }
  if (normalized === 'contacts') {
    return { kind: 'pm', value: 'android.permission.READ_CONTACTS', type: 'contacts' };
  }
  if (normalized === 'notifications') {
    return {
      kind: 'notifications',
      appOps: 'POST_NOTIFICATION',
      permission: 'android.permission.POST_NOTIFICATIONS',
    };
  }
  throw new AppError(
    'INVALID_ARGS',
    `Unsupported permission target on Android: ${permissionTarget}. Use camera|microphone|photos|contacts|notifications.`,
  );
}

async function setAndroidPhotoPermission(
  device: DeviceInfo,
  appPackage: string,
  pmAction: 'grant' | 'revoke',
): Promise<void> {
  const sdkInt = await getAndroidSdkInt(device);
  const candidates =
    sdkInt !== null && sdkInt >= 33
      ? ['android.permission.READ_MEDIA_IMAGES', 'android.permission.READ_EXTERNAL_STORAGE']
      : ['android.permission.READ_EXTERNAL_STORAGE', 'android.permission.READ_MEDIA_IMAGES'];

  const failures: Array<{ permission: string; stderr: string; exitCode: number }> = [];
  for (const permission of candidates) {
    const result = await runAndroidAdb(device, ['shell', 'pm', pmAction, appPackage, permission], {
      allowFailure: true,
    });
    if (result.exitCode === 0) return;
    failures.push({ permission, stderr: result.stderr, exitCode: result.exitCode });
  }

  throw new AppError('COMMAND_FAILED', `Failed to ${pmAction} Android photos permission`, {
    appPackage,
    sdkInt,
    attempts: failures,
  });
}

async function setAndroidNotificationPermission(
  device: DeviceInfo,
  appPackage: string,
  action: 'grant' | 'deny' | 'reset',
  target: { appOps: string; permission: string },
): Promise<void> {
  const appOpsMode = action === 'grant' ? 'allow' : action === 'deny' ? 'deny' : 'default';
  if (action === 'grant') {
    await runAndroidAdb(device, ['shell', 'pm', 'grant', appPackage, target.permission], {
      allowFailure: true,
    });
  } else {
    await runAndroidAdb(device, ['shell', 'pm', 'revoke', appPackage, target.permission], {
      allowFailure: true,
    });
    if (action === 'reset') {
      await runAndroidAdb(
        device,
        ['shell', 'pm', 'clear-permission-flags', appPackage, target.permission, 'user-set'],
        { allowFailure: true },
      );
      await runAndroidAdb(
        device,
        ['shell', 'pm', 'clear-permission-flags', appPackage, target.permission, 'user-fixed'],
        { allowFailure: true },
      );
    }
  }
  await runAndroidAdb(device, ['shell', 'appops', 'set', appPackage, target.appOps, appOpsMode]);
}

async function getAndroidSdkInt(device: DeviceInfo): Promise<number | null> {
  const result = await runAndroidAdb(device, ['shell', 'getprop', 'ro.build.version.sdk'], {
    allowFailure: true,
  });
  if (result.exitCode !== 0) return null;
  const value = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}
