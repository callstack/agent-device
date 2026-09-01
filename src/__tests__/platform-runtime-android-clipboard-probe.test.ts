import { describe, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createAndroidToolHost } from '../platform-runtime-android-tool-host.ts';

const runAndroidAdb = vi.hoisted(() => vi.fn());

vi.mock('@agent-device/platform-android/mechanics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/platform-android/mechanics')>()),
  runAndroidAdb,
}));

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel 9 Pro XL',
  kind: 'emulator',
  booted: true,
};

function adbResult(exitCode: number, stdout = '', stderr = '') {
  return { exitCode, stdout, stderr, stdoutBuffer: Buffer.from(stdout) };
}

async function probe() {
  const host = createAndroidToolHost();
  return await host.probeClipboardShellSupport?.(device);
}

// The probe runs with `allowFailure`, so every adb outcome short of a transport throw arrives as an
// ordinary result. Anything the adapter reports as `supported` is cached for the runtime owner's
// lifetime, so a wrong admission here is not a single bad answer -- it advertises a clipboard the
// build may not have until the daemon restarts.
describe('android clipboard shell probe: what each adb result is allowed to prove', () => {
  test('a clean exit is the only thing that proves support', async () => {
    runAndroidAdb.mockResolvedValueOnce(adbResult(0, 'clipboard contents'));
    await expect(probe()).resolves.toBe('supported');
  });

  test('an empty clipboard on a clean exit still proves support', async () => {
    runAndroidAdb.mockResolvedValueOnce(adbResult(0, ''));
    await expect(probe()).resolves.toBe('supported');
  });

  test('the missing-shell prose proves the build ships no clipboard command', async () => {
    runAndroidAdb.mockResolvedValueOnce(
      adbResult(255, '', 'Error: no shell command implementation.'),
    );
    await expect(probe()).resolves.toBe('unsupported');
  });

  // The planted red: before the fix every non-zero result that lacked the missing-shell prose fell
  // through to `supported`, so an offline device advertised a working clipboard.
  test.each([
    ['a device that dropped off the bridge', 'error: device offline'],
    ['an unauthorized device', 'error: device unauthorized.'],
    ['a bridge that never found the device', "error: device '(null)' not found"],
    ['a generic adb failure', 'error: closed'],
  ])('%s refuses rather than admitting support', async (_case, stderr) => {
    runAndroidAdb.mockResolvedValueOnce(adbResult(1, '', stderr));
    await expect(probe()).resolves.toBe('probe-failed');
  });

  test('a transport throw refuses rather than admitting support', async () => {
    runAndroidAdb.mockRejectedValueOnce(new Error('spawn adb ENOENT'));
    await expect(probe()).resolves.toBe('probe-failed');
  });

  // adb reports the missing shell command non-zero, so the prose is only ever evidence about a
  // call that failed -- which is exactly why it must not be read on a call that succeeded.
  test.each([
    ['stderr', '', 'Unknown command: clipboard'],
    ['stdout', 'No shell command implementation.', ''],
  ])('missing-shell prose on %s of a non-zero exit reads as unsupported', async (_c, out, err) => {
    runAndroidAdb.mockResolvedValueOnce(adbResult(1, out, err));
    await expect(probe()).resolves.toBe('unsupported');
  });

  // The second planted red: on a clean exit stdout is the clipboard's *contents*, so reading the
  // prose first let a user who had copied one of these phrases -- from a terminal, a bug report,
  // this very file -- brand their own working clipboard `unsupported` for the owner's lifetime.
  test.each([
    ['unknown command'],
    ['no shell command implementation'],
    ['adb said: Unknown command: clipboard'],
    ['No shell command implementation.'],
  ])('a clipboard holding %j is still supported', async (contents) => {
    runAndroidAdb.mockResolvedValueOnce(adbResult(0, contents));
    await expect(probe()).resolves.toBe('supported');
  });
});
