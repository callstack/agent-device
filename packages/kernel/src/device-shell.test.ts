import { describe, expect, it } from 'vitest';
import {
  assertDeviceShellArgv,
  deviceShellArgv,
  deviceShellExecutableOf,
  relayDeviceShellArgvWithoutOptions,
  shellFragment,
} from './device-shell.ts';

const UNGUARDED = expect.objectContaining({
  code: 'INVALID_ARGS',
  details: expect.objectContaining({ reason: 'unguarded-device-shell-argv' }),
});

describe('deviceShellArgv', () => {
  it('renders safe words byte-identical and quotes injection vectors', () => {
    expect(deviceShellArgv('adb', 'shell', ['am', 'force-stop', 'com.example.app'])).toEqual([
      'shell',
      'am',
      'force-stop',
      'com.example.app',
    ]);
    expect(deviceShellArgv('adb', 'shell', ['input', 'text', 'hi; rm -rf / "$(id)"'])).toEqual([
      'shell',
      'input',
      'text',
      `'hi; rm -rf / "$(id)"'`,
    ]);
  });

  it('renders numbers, fragments, and a transport prefix', () => {
    expect(
      deviceShellArgv(
        'adb',
        'exec-out',
        ['input', 'tap', 10, 20.5, shellFragment('| head -c 1')],
        ['-s', 'emulator-5554'],
      ),
    ).toEqual(['-s', 'emulator-5554', 'exec-out', 'input', 'tap', '10', '20.5', '| head -c 1']);
  });

  it('quotes an empty word so the device shell receives an explicit empty argument', () => {
    expect(deviceShellArgv('adb', 'shell', ['settings', 'put', 'ns', 'key', ''])).toEqual([
      'shell',
      'settings',
      'put',
      'ns',
      'key',
      "''",
    ]);
  });

  it('escapes what HDC double-quoting leaves live instead of quoting around it', () => {
    expect(
      deviceShellArgv('hdc', 'shell', ['am', 'force-stop', 'com.example.app'], ['-t', 'target']),
    ).toEqual(['-t', 'target', 'shell', 'am', 'force-stop', 'com.example.app']);
    expect(
      deviceShellArgv('hdc', 'shell', [
        'uitest',
        'uiInput',
        'inputText',
        307,
        1334,
        'a;b $(id) \'q\' "d" `tick` |wc > /tmp/harm-pwned',
      ]),
    ).toEqual([
      'shell',
      'uitest',
      'uiInput',
      'inputText',
      '307',
      '1334',
      'a;b \\$(id) \'q\' \\"d\\" \\`tick\\` |wc > /tmp/harm-pwned',
    ]);
    expect(deviceShellArgv('hdc', 'shell', [String.raw`C:\Users\me\app.apk`])).toEqual([
      'shell',
      String.raw`C:\\Users\\me\\app.apk`,
    ]);
  });

  it('refuses a shell fragment on the HDC transport, which cannot carry a script', () => {
    expect(() => deviceShellArgv('hdc', 'shell', [shellFragment('hilog | tail -n 1')])).toThrow(
      expect.objectContaining({
        code: 'INVALID_ARGS',
        details: expect.objectContaining({ reason: 'hdc-shell-fragment-unsupported' }),
      }),
    );
  });

  it('refuses an empty word on the HDC transport, which drops it on the way to the device', () => {
    expect(() =>
      deviceShellArgv('hdc', 'shell', ['uitest', 'uiInput', 'inputText', 1, 2, '']),
    ).toThrow(
      expect.objectContaining({
        code: 'INVALID_ARGS',
        details: expect.objectContaining({
          reason: 'hdc-empty-word-unsupported',
          hint: expect.any(String),
        }),
      }),
    );
  });
});

describe('assertDeviceShellArgv', () => {
  it('accepts non-shell argv and argv minted by deviceShellArgv', () => {
    expect(() => assertDeviceShellArgv(['install', '-r', 'app.apk'], 'test')).not.toThrow();
    expect(() =>
      assertDeviceShellArgv(deviceShellArgv('adb', 'shell', ['id']), 'test'),
    ).not.toThrow();
    expect(() =>
      assertDeviceShellArgv(deviceShellArgv('adb', 'shell', ['id'], ['-s', 'serial']), 'test'),
    ).not.toThrow();
  });

  it('refuses a literal, variable-built, or plainly copied device-shell argv', () => {
    const subcommand = 'shell';
    const variableBuilt = [subcommand, 'input', 'text', 'x; reboot'];
    const copied = [...deviceShellArgv('adb', 'shell', ['id'])];
    for (const args of [['shell', 'id'], ['exec-out', 'screencap', '-p'], variableBuilt, copied]) {
      expect(() => assertDeviceShellArgv(args, 'test')).toThrow(UNGUARDED);
      expect(() => assertDeviceShellArgv(args, 'test')).toThrow(/deviceShellArgv/);
    }
  });

  it('keeps a minted command accepted after any number of other mints', () => {
    const constant = deviceShellArgv('adb', 'shell', ['dumpsys', 'window', 'windows']);
    for (let index = 0; index < 5_000; index += 1)
      deviceShellArgv('adb', 'shell', ['input', 'tap', index]);
    expect(() => assertDeviceShellArgv(constant, 'test')).not.toThrow();
  });

  it('keeps a command minted with its transport addressing after a transport removes it', () => {
    const addressed = deviceShellArgv(
      'adb',
      'shell',
      ['id'],
      ['-P', '15037', '-s', 'emulator-5554'],
    );
    const adopted = relayDeviceShellArgvWithoutOptions(addressed, 2, 2);
    expect(adopted).toEqual(['-P', '15037', 'shell', 'id']);
    expect(() => assertDeviceShellArgv(adopted, 'test')).not.toThrow();
    const payload = relayDeviceShellArgvWithoutOptions(adopted, 0, 2);
    expect(payload).toEqual(['shell', 'id']);
    expect(() => assertDeviceShellArgv(payload, 'test')).not.toThrow();
  });

  it('refuses a relay that reaches the device command, and one that never had a minted command', () => {
    const addressed = deviceShellArgv('adb', 'shell', ['id'], ['-s', 'emulator-5554']);
    const truncated = relayDeviceShellArgvWithoutOptions(addressed, 3, 1);
    expect(() => assertDeviceShellArgv(truncated, 'test')).toThrow(UNGUARDED);
    const raw = ['-s', 'emulator-5554', 'shell', 'whoami'];
    expect(() =>
      assertDeviceShellArgv(relayDeviceShellArgvWithoutOptions(raw, 0, 2), 'test'),
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
