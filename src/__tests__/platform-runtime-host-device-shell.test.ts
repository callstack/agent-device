import { expect, test } from 'vitest';
import { deviceShellArgv } from '@agent-device/kernel/device-shell';
import { assertHostDeviceShellRequest } from '../platform-runtime-host-device-shell.ts';

test('the host command port holds adb and hdc requests to the device-shell guard', () => {
  const unguarded = expect.objectContaining({
    code: 'INVALID_ARGS',
    details: expect.objectContaining({ reason: 'unguarded-device-shell-argv' }),
  });
  for (const executable of ['adb', '/opt/sdk/platform-tools/adb.exe', 'hdc', '/opt/hdc']) {
    expect(() =>
      assertHostDeviceShellRequest({ executable, args: ['-s', 'serial', 'shell', 'whoami'] }),
    ).toThrow(unguarded);
    expect(() =>
      assertHostDeviceShellRequest({
        executable,
        args: deviceShellArgv('shell', ['id'], ['-s', 'serial']),
      }),
    ).not.toThrow();
    expect(() =>
      assertHostDeviceShellRequest({ executable, args: ['devices', '-l'] }),
    ).not.toThrow();
  }
  expect(() =>
    assertHostDeviceShellRequest({ executable: 'xcrun', args: ['simctl', 'shell'] }),
  ).not.toThrow();
});
