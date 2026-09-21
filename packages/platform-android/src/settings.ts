import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { deviceShellArgv } from '@agent-device/kernel/device-shell';
import { requireLocationCoordinates } from '@agent-device/kernel/location-coordinates';
import {
  parseTextSizeCategory,
  READABLE_SETTINGS,
  textSizeSettingPayload,
  TEXT_SIZE_CATEGORIES,
  type ReadSettingResult,
  type SettingOptions,
  type TextSizeSettingPayload,
} from '@agent-device/contracts/settings';
import {
  parseAppearanceAction,
  parseSettingState,
  summarizeCommandAttemptFailures,
  type CommandAttemptFailure,
} from './settings-parsing.ts';
import { runAndroidAdb, runAndroidShell } from './adb.ts';
import { setAndroidAirplaneMode } from './settings-airplane.ts';
import { androidAdbResultError } from './adb-executor.ts';
import { resolveAndroidApp } from './app-deployment-resolution.ts';
import { setAndroidPermission } from './settings-permission.ts';

const ANDROID_ANIMATION_SCALE_SETTINGS = [
  'window_animation_scale',
  'transition_animation_scale',
  'animator_duration_scale',
] as const;

/**
 * The Android half of `settings text-size`. Android has no content-size category: its preferred text
 * size is one `system font_scale` multiplier that every app scales its own fonts from. The shared
 * ladder is therefore expressed here as multipliers, and only here — the command surface, the CLI,
 * and the read payload all speak the ladder.
 *
 * The seven standard rungs are the Dynamic Type body ratios against the default size, rounded to two
 * decimals: 14/17, 15/17, 16/17, 17/17, 19/17, 21/17, 23/17. The five accessibility rungs are
 * Android's own larger range rather than an Apple ratio: Android has no accessibility tier below
 * 1.4x, and 3.2 is the largest multiplier its own tooling documents. Every rung must stay strictly
 * increasing and distinct, because a read names the nearest rung to whatever the device holds.
 *
 * This table lives beside the dispatcher that selects it rather than in its own module because
 * `mechanics.ts` is a CLI-eager entry whose import closure is ratcheted by
 * `scripts/__tests__/eager-closure-budgets.test.ts`: a new static module on this path is a growth
 * the gate refuses.
 */
const TEXT_SIZE_FONT_SCALES = {
  'extra-small': '0.82',
  small: '0.88',
  medium: '0.94',
  large: '1.0',
  'extra-large': '1.12',
  'extra-extra-large': '1.24',
  'extra-extra-extra-large': '1.35',
  'accessibility-medium': '1.5',
  'accessibility-large': '1.75',
  'accessibility-extra-large': '2.0',
  'accessibility-extra-extra-large': '2.5',
  'accessibility-extra-extra-extra-large': '3.2',
} as const satisfies Record<(typeof TEXT_SIZE_CATEGORIES)[number], string>;

/** The scale a device with no `font_scale` row holds: Android's own default, which is `large`. */
const DEFAULT_FONT_SCALE = TEXT_SIZE_FONT_SCALES.large;

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
      await runAndroidShell(device, ['svc', 'wifi', enabled ? 'enable' : 'disable']);
      return;
    }
    case 'airplane': {
      return await setAndroidAirplaneMode(device, parseSettingState(state));
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
      await runAndroidShell(device, ['settings', 'put', 'secure', 'location_mode', mode]);
      return;
    }
    case 'animations': {
      const enabled = parseSettingState(state);
      const scale = enabled ? '1' : '0';
      for (const key of ANDROID_ANIMATION_SCALE_SETTINGS) {
        await runAndroidShell(device, ['settings', 'put', 'global', key, scale]);
      }
      return { scale, keys: [...ANDROID_ANIMATION_SCALE_SETTINGS] };
    }
    case 'appearance': {
      const target = await resolveAndroidAppearanceTarget(device, state);
      await runAndroidShell(device, ['cmd', 'uimode', 'night', target === 'dark' ? 'yes' : 'no']);
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
      await runAndroidShell(device, ['am', 'force-stop', resolved.value], {
        allowFailure: true,
      });
      const result = await runAndroidShell(device, ['pm', 'clear', resolved.value], {
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
      return await setAndroidPermission(device, appPackage, state, options);
    }
    case 'text-size': {
      return await setAndroidTextSize(device, state);
    }
    default:
      throw new AppError('INVALID_ARGS', `Unsupported setting: ${setting}`);
  }
}

/**
 * The ONE place an Android target answers `settings <setting>` with the value it holds. The command
 * surface only sends a setting its own vocabulary declares readable, so a name outside this switch
 * is a leaf mismatch rather than a user typo, and says so.
 */
export async function readAndroidSetting(
  device: DeviceInfo,
  setting: string,
): Promise<ReadSettingResult> {
  if (setting.toLowerCase() === 'text-size') return await readAndroidTextSize(device);
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    `Reading the "${setting}" setting back is not supported on Android targets.`,
    {
      deviceId: device.id,
      setting,
      reason: 'setting-read-unsupported-on-leaf',
      hint: `Android targets read back ${READABLE_SETTINGS.join(', ')}.`,
    },
  );
}

async function setAndroidTextSize(
  device: DeviceInfo,
  state: string,
): Promise<TextSizeSettingPayload> {
  const category = parseTextSizeCategory(state);
  const fontScale = TEXT_SIZE_FONT_SCALES[category];
  await runAndroidShell(device, ['settings', 'put', 'system', 'font_scale', fontScale]);
  return textSizeSettingPayload(category, fontScale);
}

/**
 * Reads `font_scale` back as a ladder rung. A multiplier that is not one this module writes — an OEM
 * default, or a value someone set by hand — still has a nearest rung, and the payload keeps the
 * exact multiplier beside it so the normalization stays auditable rather than looking like a match.
 */
async function readAndroidTextSize(device: DeviceInfo): Promise<TextSizeSettingPayload> {
  const result = await runAndroidShell(device, ['settings', 'get', 'system', 'font_scale']);
  const reported = result.stdout.trim();
  // `null` is the sentinel `settings get` prints for a row that was never written, and the only
  // answer that means "the device holds its default". Empty output is a read that saw nothing, and
  // inventing a multiplier for it would report a size the device was never asked to hold.
  const fontScale = reported === 'null' ? DEFAULT_FONT_SCALE : reported;
  // A strict decimal, not `parseFloat`'s longest numeric prefix: a device answering `1.2-beta` or
  // `12 apples` has a value this ladder cannot order, and reporting it as a rung would hide that.
  const scale = /^(\d+(\.\d+)?)$/.test(fontScale) ? Number(fontScale) : Number.NaN;
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new AppError(
      'COMMAND_FAILED',
      `Android reported an unusable font scale: ${reported || '(empty)'}`,
      {
        deviceId: device.id,
        fontScale: reported,
        hint: 'Run `adb shell settings get system font_scale` to see what the device holds.',
      },
    );
  }
  return textSizeSettingPayload(nearestTextSizeCategory(scale), fontScale);
}

function nearestTextSizeCategory(scale: number): (typeof TEXT_SIZE_CATEGORIES)[number] {
  let nearest: (typeof TEXT_SIZE_CATEGORIES)[number] = TEXT_SIZE_CATEGORIES[0];
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const category of TEXT_SIZE_CATEGORIES) {
    const distance = Math.abs(Number.parseFloat(TEXT_SIZE_FONT_SCALES[category]) - scale);
    if (distance >= nearestDistance) continue;
    nearest = category;
    nearestDistance = distance;
  }
  return nearest;
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
): (readonly string[])[] {
  const fingerprintId = action === 'match' ? '1' : '9999';
  const attempts: (readonly string[])[] = [
    deviceShellArgv('adb', 'shell', ['cmd', 'fingerprint', 'touch', fingerprintId]),
    deviceShellArgv('adb', 'shell', ['cmd', 'fingerprint', 'finger', fingerprintId]),
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

  const currentResult = await runAndroidShell(device, ['cmd', 'uimode', 'night'], {
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
