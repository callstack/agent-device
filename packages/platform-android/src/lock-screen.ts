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
} as const satisfies ReasonTable<'lock-screen'>;

/** How long the keyguard has to reach the requested state after the key event or dismissal. */
const LOCK_STATE_WINDOW_MS = 5_000;
const LOCK_STATE_POLL_MS = 250;

const SECURE_LOCK_HINT =
  'unlock never enters a credential. Unlock the device by hand, or remove its screen lock in Settings > Security, then retry.';
const STATE_UNREADABLE_HINT =
  'Check adb shell dumpsys window, adb shell dumpsys lock_settings, and adb shell am get-current-user; if the device is still booting, retry once it reports a user.';
const LOCK_UNVERIFIED_HINT =
  'Android raised no keyguard after KEYCODE_SLEEP. A device whose screen lock is set to None has no lock screen to show.';
const UNLOCK_UNVERIFIED_HINT =
  'The keyguard stayed up after wm dismiss-keyguard. Take a screenshot to see what covers the screen.';

/**
 * Shows the keyguard with KEYCODE_SLEEP and returns once `dumpsys window` reports it. A keyguard
 * already up is left alone.
 */
export async function lockAndroidScreen(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (await readKeyguardBeforeDispatch(device, signal)) return;
  await pressAndroidHardwareButton(device, 'sleep');
  await awaitKeyguardState(device, true, signal);
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
  await awaitKeyguardState(device, false, signal, dismiss);
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
 * `retry` runs after each wait that follows a read in the wrong state.
 */
async function awaitKeyguardState(
  device: DeviceInfo,
  showing: boolean,
  signal: AbortSignal | undefined,
  retry?: () => Promise<void>,
): Promise<void> {
  const deadline = Deadline.fromTimeoutMs(LOCK_STATE_WINDOW_MS);
  while ((await readAndroidKeyguardShowing(device, signal)) !== showing) {
    if (deadline.isExpired()) {
      throw new AppError(
        'COMMAND_FAILED',
        `${device.name} still reports the keyguard ${showing ? 'hidden' : 'showing'}`,
        {
          deviceId: device.id,
          reason: LOCK_SCREEN_REASONS.stateUnverified.reason,
          dispatched: 'unknown',
          hint: showing ? LOCK_UNVERIFIED_HINT : UNLOCK_UNVERIFIED_HINT,
        },
      );
    }
    await sleep(LOCK_STATE_POLL_MS, signal);
    await retry?.();
  }
}

async function refuseSecureLock(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<void> {
  const credential = await readCredentialType(device, signal);
  if (credential === 'none') return;
  if (credential === undefined) {
    throw stateUnreadable(device, 'the screen lock type of the foreground user');
  }
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    `The screen lock of ${device.name} asks for a credential (${credential}), which lock-screen unlock does not enter`,
    {
      deviceId: device.id,
      reason: LOCK_SCREEN_REASONS.secureLock.reason,
      credentialType: credential,
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
 * The foreground user's credential type from `dumpsys lock_settings`, lower-cased (`none`, `pin`,
 * `pattern`, `password`), or `undefined` when the user or its `CredentialType:` line is missing.
 * Builds that print the type as a number report it unchanged, except -1, which is none.
 */
async function readCredentialType(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const userId = await readAndroidCurrentUserId(device);
  if (userId === undefined) return undefined;
  const { stdout } = await runCheckedAndroidShell(device, ['dumpsys', 'lock_settings'], signal);
  const type = credentialTypeForUser(stdout, userId);
  if (type === undefined) return undefined;
  return type === '-1' ? 'none' : type.toLowerCase();
}

/** The `CredentialType:` value inside the `User <id>` block of a `dumpsys lock_settings` dump. */
function credentialTypeForUser(dump: string, userId: number): string | undefined {
  let inUser = false;
  for (const line of dump.split('\n')) {
    const user = /^\s*User (\d+)\s*$/.exec(line);
    if (user) {
      inUser = Number(user[1]) === userId;
      continue;
    }
    if (!inUser) continue;
    const type = /^\s*CredentialType:\s*(\S+)/.exec(line);
    if (type) return type[1];
  }
  return undefined;
}
