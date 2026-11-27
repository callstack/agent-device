import { LOCK_SCREEN_REASONS } from '@agent-device/contracts/device';
import { Deadline, sleep } from '@agent-device/host-kit/retry';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';

import { pressAndroidHardwareButton } from './input-actions.ts';
import { readAndroidKeyguardShowing, runCheckedAndroidShell } from './keyguard.ts';
import { readAndroidCurrentUserId } from './permission-grant-state.ts';

/** The Android-only `lock-screen` reasons; the shared ones are in LOCK_SCREEN_REASONS. */
const ANDROID_LOCK_SCREEN_REASONS = {
  // dumpsys reported no keyguard state, or no lock type for the foreground user, so nothing was sent.
  stateUnreadable: { reason: 'lock-screen-state-unreadable' },
  // The screen lock is set to None, so there is no lock screen to show; nothing was sent.
  lockScreenDisabled: { reason: 'lock-screen-disabled' },
} as const satisfies ReasonTable<'lock-screen'>;

/** How long the keyguard has to reach the requested state after the key event or dismissal. */
const LOCK_STATE_WINDOW_MS = 5_000;
const LOCK_STATE_POLL_MS = 250;
/**
 * A secure device whose "Power button instantly locks" is off shows the keyguard only after its
 * "Lock after screen timeout" delay (`lock_screen_lock_after_timeout`). On an Android 16 emulator
 * the keyguard showed about 0.2 s after that delay, and never sooner than 5 s, even with the
 * setting unset, 0 or 2000. The lock waits that long on top of its own window, up to the cap,
 * which keeps the command inside the daemon's 90 s request envelope.
 */
const LOCK_AFTER_TIMEOUT_MIN_MS = 5_000;
const LOCK_AFTER_TIMEOUT_CAP_MS = 60_000;

const SECURE_LOCK_HINT =
  'unlock never enters a credential. Unlock the device by hand, or remove its screen lock in Settings > Security, then retry.';
const STATE_UNREADABLE_HINT =
  'Check adb shell dumpsys window, adb shell dumpsys lock_settings, and adb shell am get-current-user; if the device is still booting, retry once it reports a user.';
const LOCK_DISABLED_HINT =
  'Set a screen lock other than None in Settings > Security > Screen lock (Swipe needs no credential), then retry.';
const LOCK_UNVERIFIED_HINT = 'Android raised no keyguard after KEYCODE_SLEEP.';
const DEFERRED_LOCK_UNVERIFIED_HINT =
  'Android raised no keyguard after KEYCODE_SLEEP. With "Power button instantly locks" off, the keyguard waits for "Lock after screen timeout"; a delay above one minute outlasts this command.';
const UNLOCK_UNVERIFIED_HINT =
  'The keyguard stayed up after wm dismiss-keyguard. Take a screenshot to see what covers the screen.';

type LockSettings = Readonly<{ credentialType: string; lockScreenDisabled: boolean }>;

/**
 * Shows the keyguard with KEYCODE_SLEEP and returns once `dumpsys window` reports it. A keyguard
 * already up is left alone, and a screen lock set to None is refused before anything is sent.
 */
export async function lockAndroidScreen(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (await readKeyguardBeforeDispatch(device, signal)) return;
  const settings = await readLockSettingsBeforeDispatch(device, signal);
  if (settings.lockScreenDisabled) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `The screen lock of ${device.name} is set to None, so there is no lock screen to show`,
      {
        deviceId: device.id,
        reason: ANDROID_LOCK_SCREEN_REASONS.lockScreenDisabled.reason,
        dispatched: 'no',
        hint: LOCK_DISABLED_HINT,
      },
    );
  }
  const deferMs =
    settings.credentialType === 'none' ? 0 : await readLockAfterTimeoutMs(device, signal);
  await pressAndroidHardwareButton(device, 'sleep');
  await awaitKeyguardState(device, true, signal, {
    windowMs: LOCK_STATE_WINDOW_MS + Math.min(deferMs, LOCK_AFTER_TIMEOUT_CAP_MS),
    hint: deferMs > 0 ? DEFERRED_LOCK_UNVERIFIED_HINT : LOCK_UNVERIFIED_HINT,
  });
}

/**
 * Wakes the screen with KEYCODE_WAKEUP and dismisses the keyguard with `wm dismiss-keyguard`, so
 * the app that was in front before the lock is in front again. A keyguard that asks for a
 * credential is refused before anything is sent: nothing here types a PIN, pattern, or password.
 */
export async function unlockAndroidScreen(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<void> {
  const showing = await readKeyguardBeforeDispatch(device, signal);
  if (showing) await refuseSecureLock(device, signal);
  // The wake event never toggles, so a screen that is already on stays on.
  await pressAndroidHardwareButton(device, 'wake');
  if (!showing) return;
  const dismiss = async () => {
    await runCheckedAndroidShell(device, ['wm', 'dismiss-keyguard'], signal);
  };
  await dismiss();
  // A dismissal that lands while the screen is still waking can be dropped, so each poll that
  // still finds the keyguard sends it again; a secure keyguard was refused above.
  await awaitKeyguardState(device, false, signal, {
    windowMs: LOCK_STATE_WINDOW_MS,
    hint: UNLOCK_UNVERIFIED_HINT,
    retry: dismiss,
  });
}

/** The keyguard state before anything is sent; a dump without one refuses instead of guessing. */
async function readKeyguardBeforeDispatch(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const showing = await readAndroidKeyguardShowing(device, signal);
  if (showing === undefined) throw stateUnreadable(device, 'the keyguard state');
  return showing;
}

/**
 * Polls until the keyguard reaches `showing`. The window starts after the dispatch returned, and
 * every wait is followed by a read, so a state the device reached during the last wait is seen.
 * `retry` runs after each wait that follows a read in the wrong state. The dispatch was sent, so
 * a failure discloses `dispatched: unknown`: the only wire value for a send that may have acted.
 */
async function awaitKeyguardState(
  device: DeviceInfo,
  showing: boolean,
  signal: AbortSignal | undefined,
  options: Readonly<{ windowMs: number; hint: string; retry?: () => Promise<void> }>,
): Promise<void> {
  const deadline = Deadline.fromTimeoutMs(options.windowMs);
  while ((await readAndroidKeyguardShowing(device, signal)) !== showing) {
    if (deadline.isExpired()) {
      throw new AppError(
        'COMMAND_FAILED',
        `${device.name} still reports the keyguard ${showing ? 'hidden' : 'showing'}`,
        {
          deviceId: device.id,
          reason: LOCK_SCREEN_REASONS.stateUnverified.reason,
          dispatched: 'unknown',
          hint: options.hint,
        },
      );
    }
    await sleep(LOCK_STATE_POLL_MS, signal);
    await options.retry?.();
  }
}

async function refuseSecureLock(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<void> {
  const { credentialType } = await readLockSettingsBeforeDispatch(device, signal);
  if (credentialType === 'none') return;
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    `The screen lock of ${device.name} asks for a credential (${credentialType}), which lock-screen unlock does not enter`,
    {
      deviceId: device.id,
      reason: LOCK_SCREEN_REASONS.secureLock.reason,
      credentialType,
      dispatched: 'no',
      hint: SECURE_LOCK_HINT,
    },
  );
}

function stateUnreadable(device: DeviceInfo, what: string): AppError {
  return new AppError('COMMAND_FAILED', `Unable to read ${what} of ${device.name}`, {
    deviceId: device.id,
    reason: ANDROID_LOCK_SCREEN_REASONS.stateUnreadable.reason,
    dispatched: 'no',
    hint: STATE_UNREADABLE_HINT,
  });
}

/**
 * The foreground user's lock settings from `dumpsys lock_settings`: the credential type,
 * lower-cased (`none`, `pin`, `pattern`, `password`), and whether the lock screen is disabled,
 * which builds print only for a user with no credential. Builds that print the type as a number
 * report it unchanged, except -1, which is none. A missing user or type refuses before dispatch.
 */
async function readLockSettingsBeforeDispatch(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<LockSettings> {
  const userId = await readAndroidCurrentUserId(device);
  const { stdout } =
    userId === undefined
      ? { stdout: '' }
      : await runCheckedAndroidShell(device, ['dumpsys', 'lock_settings'], signal);
  const block = userId === undefined ? undefined : userBlock(stdout, userId);
  const type = block === undefined ? undefined : /^\s*CredentialType:\s*(\S+)/m.exec(block)?.[1];
  if (type === undefined) {
    throw stateUnreadable(device, 'the screen lock type of the foreground user');
  }
  return {
    credentialType: type === '-1' ? 'none' : type.toLowerCase(),
    lockScreenDisabled: /^\s*IsLockScreenDisabled:\s*true\b/m.test(block!),
  };
}

/** The lines inside the `User <id>` block of a `dumpsys lock_settings` dump. */
function userBlock(dump: string, userId: number): string | undefined {
  const lines: string[] = [];
  let found = false;
  let inUser = false;
  for (const line of dump.split('\n')) {
    const user = /^\s*User (\d+)\s*$/.exec(line);
    if (user) {
      inUser = Number(user[1]) === userId;
      found ||= inUser;
      continue;
    }
    if (inUser) lines.push(line);
  }
  return found ? lines.join('\n') : undefined;
}

/** How long Android defers the keyguard: `lock_screen_lock_after_timeout`, never under 5 s. */
async function readLockAfterTimeoutMs(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<number> {
  const { stdout } = await runCheckedAndroidShell(
    device,
    ['settings', 'get', 'secure', 'lock_screen_lock_after_timeout'],
    signal,
  );
  const value = Number.parseInt(stdout.trim(), 10);
  return Number.isInteger(value)
    ? Math.max(value, LOCK_AFTER_TIMEOUT_MIN_MS)
    : LOCK_AFTER_TIMEOUT_MIN_MS;
}
