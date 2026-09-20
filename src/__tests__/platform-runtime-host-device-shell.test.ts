import { expect, test } from 'vitest';
import { deviceShellArgv } from '@agent-device/kernel/device-shell';
import { guardedHostCommandArgv } from '../platform-runtime-host-device-shell.ts';

test('the host command port holds adb and hdc requests to the device-shell guard', () => {
  const unguarded = expect.objectContaining({
    code: 'INVALID_ARGS',
    details: expect.objectContaining({ reason: 'unguarded-device-shell-argv' }),
  });
  for (const executable of ['adb', '/opt/sdk/platform-tools/adb.exe', 'hdc', '/opt/hdc']) {
    expect(() =>
      guardedHostCommandArgv({ executable, args: ['-s', 'serial', 'shell', 'whoami'] }),
    ).toThrow(unguarded);
    expect(() =>
      guardedHostCommandArgv({
        executable,
        args: deviceShellArgv('adb', 'shell', ['whoami'], ['-s', 'serial']),
      }),
    ).not.toThrow();
    expect(() => guardedHostCommandArgv({ executable, args: ['devices', '-l'] })).not.toThrow();
  }
  expect(() =>
    guardedHostCommandArgv({ executable: 'xcrun', args: ['simctl', 'shell'] }),
  ).not.toThrow();
});

test('the host command port dispatches the request array, not a copy of it', () => {
  const args = deviceShellArgv('adb', 'shell', ['id']);
  // A copy would be a different array, and the dispatch guard downstream recognizes the array the
  // funnel built — so the port has to hand on the very same one.
  expect(guardedHostCommandArgv({ executable: 'adb', args })).toBe(args);
});
