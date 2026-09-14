import { describe, expect, it } from 'vitest';
import {
  assertDeviceShellArgv,
  deviceShellArgv,
  deviceShellExecutableOf,
  relayDeviceShellArgv,
  shellFragment,
} from './device-shell.ts';

const UNGUARDED = expect.objectContaining({
  code: 'INVALID_ARGS',
  details: expect.objectContaining({ reason: 'unguarded-device-shell-argv' }),
});

describe('deviceShellArgv', () => {
  it('renders safe words byte-identical and quotes injection vectors', () => {
    expect(deviceShellArgv('shell', ['am', 'force-stop', 'com.example.app'])).toEqual([
      'shell',
      'am',
      'force-stop',
      'com.example.app',
    ]);
    expect(deviceShellArgv('shell', ['input', 'text', 'hi; rm -rf / "$(id)"'])).toEqual([
      'shell',
      'input',
      'text',
      `'hi; rm -rf / "$(id)"'`,
    ]);
  });

  it('renders numbers, fragments, and a transport prefix', () => {
    expect(
      deviceShellArgv(
        'exec-out',
        ['input', 'tap', 10, 20.5, shellFragment('| head -c 1')],
        ['-s', 'emulator-5554'],
      ),
    ).toEqual(['-s', 'emulator-5554', 'exec-out', 'input', 'tap', '10', '20.5', '| head -c 1']);
  });

  it('quotes an empty word so the device shell receives an explicit empty argument', () => {
    expect(deviceShellArgv('shell', ['settings', 'put', 'ns', 'key', ''])).toEqual([
      'shell',
      'settings',
      'put',
      'ns',
      'key',
      "''",
    ]);
  });
});

describe('assertDeviceShellArgv', () => {
  it('accepts non-shell argv and argv minted by deviceShellArgv', () => {
    expect(() => assertDeviceShellArgv(['install', '-r', 'app.apk'], 'test')).not.toThrow();
    expect(() => assertDeviceShellArgv(deviceShellArgv('shell', ['id']), 'test')).not.toThrow();
    expect(() =>
      assertDeviceShellArgv(deviceShellArgv('shell', ['id'], ['-s', 'serial']), 'test'),
    ).not.toThrow();
  });

  it('refuses a literal, variable-built, or plainly copied device-shell argv', () => {
    const subcommand = 'shell';
    const variableBuilt = [subcommand, 'input', 'text', 'x; reboot'];
    const copied = [...deviceShellArgv('shell', ['id'])];
    for (const args of [['shell', 'id'], ['exec-out', 'screencap', '-p'], variableBuilt, copied]) {
      expect(() => assertDeviceShellArgv(args, 'test')).toThrow(UNGUARDED);
      expect(() => assertDeviceShellArgv(args, 'test')).toThrow(/deviceShellArgv/);
    }
  });

  it('keeps a module-level constant accepted through relays after any number of other mints', () => {
    const constant = deviceShellArgv('shell', ['dumpsys', 'window', 'windows']);
    for (let index = 0; index < 5_000; index += 1)
      deviceShellArgv('shell', ['input', 'tap', index]);
    const prefixed = relayDeviceShellArgv(constant, ['-s', 'serial', ...constant]);
    const stripped = relayDeviceShellArgv(prefixed, prefixed.slice(2));
    expect(() => assertDeviceShellArgv(constant, 'test')).not.toThrow();
    expect(() => assertDeviceShellArgv(prefixed, 'test')).not.toThrow();
    expect(() => assertDeviceShellArgv(stripped, 'test')).not.toThrow();
  });

  it('does not let a relay launder a raw argv', () => {
    const raw = ['shell', 'id'];
    expect(() =>
      assertDeviceShellArgv(relayDeviceShellArgv(raw, ['-s', 'serial', ...raw]), 'test'),
    ).toThrow(UNGUARDED);
  });
});

describe('deviceShellExecutableOf', () => {
  it('names adb and hdc by basename, ignoring path and Windows extensions', () => {
    expect(deviceShellExecutableOf('adb')).toBe('adb');
    expect(deviceShellExecutableOf('/opt/sdk/platform-tools/adb.exe')).toBe('adb');
    expect(deviceShellExecutableOf(String.raw`C:\sdk\hdc.EXE`)).toBe('hdc');
    expect(deviceShellExecutableOf('xcrun')).toBeUndefined();
    expect(deviceShellExecutableOf('/usr/bin/adbx')).toBeUndefined();
  });
});
