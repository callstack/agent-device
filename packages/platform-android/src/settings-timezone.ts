import { SETTING_RESET_STATE } from '@agent-device/contracts/settings-catalog';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError, discloseDispatch, type ReasonTable } from '@agent-device/kernel/errors';
import { runAndroidShell } from './adb.ts';
import { androidAdbResultError } from './adb-failure.ts';

/** The `error.details.reason` a time zone write states when the device kept another zone. */
const ANDROID_TIME_ZONE_REASONS = {
  // `persist.sys.timezone` did not hold the requested zone after `cmd alarm set-timezone`.
  timeZoneNotApplied: { reason: 'time-zone-not-applied' },
} as const satisfies ReasonTable<'settings'>;

/**
 * Sets the system time zone with `cmd alarm set-timezone`, the shell command for
 * `AlarmManager.setTimeZone`. Automatic time zone is turned off first, or the network would set
 * its own zone back; reset turns it on again, and the device then takes the network's zone.
 */
export async function setAndroidTimeZone(
  device: DeviceInfo,
  state: string,
): Promise<Record<string, unknown>> {
  const requested = state === SETTING_RESET_STATE ? undefined : state;
  const previousTimeZone = await readAndroidTimeZone(device);
  if (requested === undefined) {
    // The detector applies the network's zone a moment later, so there is no zone to report yet.
    await writeAndroidAutoTimeZone(device, '1');
    return { timeZone: null, previousTimeZone, autoTimeZone: true };
  }
  const previousAutoTimeZone = await readAndroidAutoTimeZone(device);
  await writeAndroidAutoTimeZone(device, '0');
  try {
    return await applyAndroidTimeZone(device, requested, previousTimeZone, previousAutoTimeZone);
  } catch (error) {
    // Every failure once automatic time zone is off, an adb transport error included, puts the
    // stored value back. A failed restore must not hide the error that caused it.
    await writeAndroidAutoTimeZone(device, previousAutoTimeZone).catch(() => undefined);
    throw error;
  }
}

async function applyAndroidTimeZone(
  device: DeviceInfo,
  requested: string,
  previousTimeZone: string,
  previousAutoTimeZone: string,
): Promise<Record<string, unknown>> {
  const result = await runAndroidShell(device, ['cmd', 'alarm', 'set-timezone', requested], {
    allowFailure: true,
  });
  // The alarm shell prints the exception and exits non-zero for a zone the device does not know.
  if (result.exitCode !== 0) {
    throw discloseDispatch(
      androidAdbResultError('Failed to set the Android time zone', result, {
        timeZone: requested,
        autoTimeZone: previousAutoTimeZone === '1',
      }),
      'unknown',
    );
  }
  const timeZone = await readAndroidTimeZone(device);
  if (timeZone !== requested) {
    throw new AppError('COMMAND_FAILED', `Android kept the time zone ${timeZone || '(empty)'}.`, {
      reason: ANDROID_TIME_ZONE_REASONS.timeZoneNotApplied.reason,
      dispatched: 'unknown',
      timeZone: requested,
      storedTimeZone: timeZone,
      autoTimeZone: previousAutoTimeZone === '1',
    });
  }
  return { timeZone, previousTimeZone, autoTimeZone: false };
}

/**
 * The `auto_time_zone` row as stored, so a failed write puts the same value back and its error
 * reports what the device holds. Only `0` is off: an absent row means the platform default, on.
 */
async function readAndroidAutoTimeZone(device: DeviceInfo): Promise<string> {
  const result = await runAndroidShell(device, ['settings', 'get', 'global', 'auto_time_zone']);
  return result.stdout.trim() === '0' ? '0' : '1';
}

async function writeAndroidAutoTimeZone(device: DeviceInfo, value: string): Promise<void> {
  await runAndroidShell(device, ['settings', 'put', 'global', 'auto_time_zone', value]);
}

async function readAndroidTimeZone(device: DeviceInfo): Promise<string> {
  const result = await runAndroidShell(device, ['getprop', 'persist.sys.timezone']);
  return result.stdout.trim();
}
