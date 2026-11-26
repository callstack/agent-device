import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('./adb.ts', () => ({ runAndroidShell: vi.fn() }));
vi.mock('./input-actions.ts', () => ({ pressAndroidHardwareButton: vi.fn(async () => {}) }));
vi.mock('./permission-grant-state.ts', () => ({ readAndroidCurrentUserId: vi.fn(async () => 0) }));
vi.mock('@agent-device/host-kit/retry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/retry')>();
  // Each poll advances the faked clock the Deadline reads, so the window ends after its polls.
  return {
    ...actual,
    sleep: vi.fn(async (ms: number) => {
      vi.setSystemTime(Date.now() + ms);
    }),
  };
});

import { runAndroidShell } from './adb.ts';
import { pressAndroidHardwareButton } from './input-actions.ts';
import {
  lockAndroidScreen,
  readAndroidLockScreenState,
  unlockAndroidScreen,
} from './lock-screen.ts';
import { readAndroidCurrentUserId } from './permission-grant-state.ts';
import { ANDROID_EMULATOR } from './runtime.fixtures.ts';

const mockShell = vi.mocked(runAndroidShell);
const SETTINGS_FOCUS_ONLY = 'mCurrentFocus=Window{42 u0 com.android.settings/.Settings}\n';
const mockPress = vi.mocked(pressAndroidHardwareButton);
const mockCurrentUser = vi.mocked(readAndroidCurrentUserId);

/** `dumpsys lock_settings` as Android 16 prints it, one block per user. */
function lockSettingsDump(users: Record<number, string>, lockScreenDisabled = false): string {
  const blocks = Object.entries(users).map(
    ([id, type]) =>
      `  User ${id}\n    LSKF-based SP protector ID: 0000000000000000\n    Quality: 0\n    CredentialType: ${type}\n` +
      (type === 'NONE' ? `    IsLockScreenDisabled: ${lockScreenDisabled}\n` : '') +
      '    SeparateChallenge: false\n',
  );
  return `Current lock settings service state:\n\nUser State:\n${blocks.join('')}\nStorage:\n  User 0 [/data/system_de/0/spblob]:\n`;
}

/**
 * One device answered by command: `keyguardReads` are the successive `isKeyguardShowing` values
 * (the last repeats), `credentials` the lock_settings blocks per user.
 */
function stubDevice(options: {
  keyguardReads: boolean[];
  credentials?: Record<number, string>;
  lockScreenDisabled?: boolean;
  lockAfterTimeout?: string;
}) {
  const reads = [...options.keyguardReads];
  mockShell.mockImplementation(async (_device, words) => {
    const command = words.join(' ');
    const answer = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });
    if (command === 'dumpsys window') {
      const showing = reads.length > 1 ? reads.shift()! : reads[0]!;
      return answer(`    isKeyguardShowing=${showing}\n`);
    }
    if (command === 'dumpsys lock_settings') {
      return answer(
        lockSettingsDump(options.credentials ?? { 0: 'NONE' }, options.lockScreenDisabled),
      );
    }
    if (command === 'settings get secure lock_screen_lock_after_timeout') {
      return answer(`${options.lockAfterTimeout ?? 'null'}\n`);
    }
    if (command === 'wm dismiss-keyguard') return answer('');
    throw new Error(`unexpected shell command: ${command}`);
  });
}

function shellCommands(): string[] {
  return mockShell.mock.calls.map(([, words]) => words.join(' '));
}

function keyguardReads(): number {
  return shellCommands().filter((command) => command === 'dumpsys window').length;
}

beforeEach(() => {
  vi.useFakeTimers();
  mockShell.mockReset();
  mockPress.mockClear();
  mockCurrentUser.mockReset();
  mockCurrentUser.mockResolvedValue(0);
});

afterEach(() => {
  vi.useRealTimers();
});

test.each([
  [true, 'locked'],
  [false, 'unlocked'],
] as const)('status reads isKeyguardShowing=%s as %s and sends nothing', async (showing, state) => {
  stubDevice({ keyguardReads: [showing] });
  await expect(readAndroidLockScreenState(ANDROID_EMULATOR, undefined)).resolves.toBe(state);
  expect(shellCommands()).toEqual(['dumpsys window']);
  expect(mockPress).not.toHaveBeenCalled();
});

test('status refuses a dump without a keyguard state instead of reporting unlocked', async () => {
  mockShell.mockResolvedValue({ stdout: 'WINDOW MANAGER POLICY STATE\n', stderr: '', exitCode: 0 });
  await expect(readAndroidLockScreenState(ANDROID_EMULATOR, undefined)).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: {
      reason: 'lock-screen-state-unreadable',
      dispatched: 'no',
      hint: expect.stringContaining('isKeyguardShowing'),
    },
  });
  expect(mockPress).not.toHaveBeenCalled();
});

test('lock leaves a keyguard that is already showing alone', async () => {
  stubDevice({ keyguardReads: [true] });
  await lockAndroidScreen(ANDROID_EMULATOR, undefined);
  expect(mockPress).not.toHaveBeenCalled();
  expect(shellCommands()).toEqual(['dumpsys window']);
});

test('lock sends KEYCODE_SLEEP and returns once the keyguard shows', async () => {
  stubDevice({ keyguardReads: [false, false, true] });
  await lockAndroidScreen(ANDROID_EMULATOR, undefined);
  expect(mockPress.mock.calls.map(([, button]) => button)).toEqual(['sleep']);
  expect(keyguardReads()).toBe(3);
  // A swipe lock has no credential, so its keyguard is never deferred.
  expect(shellCommands()).not.toContain('settings get secure lock_screen_lock_after_timeout');
});

test('lock refuses a screen lock set to None before sending anything', async () => {
  stubDevice({ keyguardReads: [false], lockScreenDisabled: true });
  await expect(lockAndroidScreen(ANDROID_EMULATOR, undefined)).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'lock-screen-disabled', dispatched: 'no' },
  });
  expect(mockPress).not.toHaveBeenCalled();
});

// With "Power button instantly locks" off, a secure keyguard waits for "Lock after screen
// timeout", so the window grows by that delay: never under 5 s, measured with the setting unset,
// 0 and 2000 on an Android 16 emulator, and never past 60 s.
test.each([
  ['an unset delay as 5 s', 'null', 10_000],
  ['a delay under 5 s as 5 s', '2000', 10_000],
  ['a 30 s delay', '30000', 35_000],
  ['a delay past one minute as 60 s', '1800000', 65_000],
])('lock on a secure device waits for %s', async (_name, lockAfterTimeout, windowMs) => {
  stubDevice({ keyguardReads: [false], credentials: { 0: 'PIN' }, lockAfterTimeout });
  await expect(lockAndroidScreen(ANDROID_EMULATOR, undefined)).rejects.toMatchObject({
    details: { reason: 'lock-screen-unverified', dispatched: 'unknown' },
  });
  // One read before the key event, then one right after it and one after each 250 ms poll.
  expect(keyguardReads()).toBe(2 + windowMs / 250);
});

test('lock on a secure device returns once the deferred keyguard shows', async () => {
  stubDevice({
    keyguardReads: [false, ...Array<boolean>(24).fill(false), true],
    credentials: { 0: 'PIN' },
    lockAfterTimeout: '5000',
  });
  await lockAndroidScreen(ANDROID_EMULATOR, undefined);
  expect(keyguardReads()).toBe(26);
});

test('lock reads the keyguard once more after the last poll before it reports unverified', async () => {
  stubDevice({ keyguardReads: [false] });
  await expect(lockAndroidScreen(ANDROID_EMULATOR, undefined)).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'lock-screen-unverified', dispatched: 'unknown' },
  });
  // One read before the key event, one right after it, then one after each of the 20 polls that
  // fit in the 5 s window.
  expect(keyguardReads()).toBe(22);
});

test('unlock wakes an unlocked screen and dismisses nothing', async () => {
  stubDevice({ keyguardReads: [false] });
  await unlockAndroidScreen(ANDROID_EMULATOR, undefined);
  expect(mockPress.mock.calls.map(([, button]) => button)).toEqual(['wake']);
  expect(shellCommands()).toEqual(['dumpsys window']);
});

test('unlock wakes the screen, dismisses a swipe keyguard until it is gone', async () => {
  stubDevice({ keyguardReads: [true, true, false] });
  await unlockAndroidScreen(ANDROID_EMULATOR, undefined);
  expect(mockPress.mock.calls.map(([, button]) => button)).toEqual(['wake']);
  // The poll that still finds the keyguard sends the dismissal again before the next read.
  expect(shellCommands()).toEqual([
    'dumpsys window',
    'dumpsys lock_settings',
    'wm dismiss-keyguard',
    'dumpsys window',
    'wm dismiss-keyguard',
    'dumpsys window',
  ]);
});

test('unlock refuses a keyguard that asks for a credential before sending anything', async () => {
  stubDevice({ keyguardReads: [true], credentials: { 0: 'PIN' } });
  await expect(unlockAndroidScreen(ANDROID_EMULATOR, undefined)).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'lock-screen-secure', credentialType: 'pin', dispatched: 'no' },
  });
  expect(mockPress).not.toHaveBeenCalled();
  expect(shellCommands()).not.toContain('wm dismiss-keyguard');
});

test('unlock reads the credential of the foreground user', async () => {
  mockCurrentUser.mockResolvedValue(10);
  stubDevice({ keyguardReads: [true], credentials: { 0: 'NONE', 10: 'PASSWORD' } });
  await expect(unlockAndroidScreen(ANDROID_EMULATOR, undefined)).rejects.toMatchObject({
    details: { reason: 'lock-screen-secure', credentialType: 'password' },
  });
});

test('unlock reads the numeric none of older builds as no credential', async () => {
  stubDevice({ keyguardReads: [true, false], credentials: { 0: '-1' } });
  await unlockAndroidScreen(ANDROID_EMULATOR, undefined);
  expect(shellCommands()).toContain('wm dismiss-keyguard');
});

test('unlock refuses when the foreground user or its credential type cannot be read', async () => {
  mockCurrentUser.mockResolvedValue(undefined);
  stubDevice({ keyguardReads: [true] });
  await expect(unlockAndroidScreen(ANDROID_EMULATOR, undefined)).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'lock-screen-state-unreadable', dispatched: 'no' },
  });

  mockCurrentUser.mockResolvedValue(7);
  stubDevice({ keyguardReads: [true], credentials: { 0: 'NONE' } });
  await expect(unlockAndroidScreen(ANDROID_EMULATOR, undefined)).rejects.toMatchObject({
    details: { reason: 'lock-screen-state-unreadable' },
  });
  expect(mockPress).not.toHaveBeenCalled();
});

test('unlock reports unverified when the keyguard stays up after the dismissal', async () => {
  stubDevice({ keyguardReads: [true] });
  await expect(unlockAndroidScreen(ANDROID_EMULATOR, undefined)).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'lock-screen-unverified' },
  });
});

test('a dump with no keyguard state refuses before anything is sent', async () => {
  mockShell.mockResolvedValue({ stdout: SETTINGS_FOCUS_ONLY, stderr: '', exitCode: 0 });
  for (const run of [lockAndroidScreen, unlockAndroidScreen]) {
    await expect(run(ANDROID_EMULATOR, undefined)).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { reason: 'lock-screen-state-unreadable', dispatched: 'no' },
    });
  }
  expect(mockPress).not.toHaveBeenCalled();
});

test('a failed keyguard read is an adb failure, not an unlocked screen', async () => {
  mockShell.mockResolvedValue({ stdout: '', stderr: 'error: closed', exitCode: 1 });
  await expect(lockAndroidScreen(ANDROID_EMULATOR, undefined)).rejects.toMatchObject({
    message: expect.stringContaining('dumpsys window'),
  });
  expect(mockPress).not.toHaveBeenCalled();
});
