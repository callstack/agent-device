import { describe, expect, it } from 'vitest';
import { AppError } from './errors.ts';
import {
  assertDeviceShellArgv,
  deviceShellArgv,
  shellFragment,
  shellQuote,
  shellQuoteIfNeeded,
} from './device-shell.ts';

describe('deviceShellArgv', () => {
  it('renders safe words byte-identical and quotes injection vectors', () => {
    expect(deviceShellArgv('shell', ['am', 'force-stop', 'com.example.app'])).toEqual([
      'shell',
      'am',
      'force-stop',
      'com.example.app',
    ]);
    expect(deviceShellArgv('shell', ['input', 'text', "hi; rm -rf /'"])).toEqual([
      'shell',
      'input',
      'text',
      String.raw`'hi; rm -rf /'\'''`,
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

  it('accepts a relayed copy of a minted argv, prefixed or stripped of transport options', () => {
    const minted = deviceShellArgv('shell', ['input', 'text', 'a b'], ['-s', 'serial']);
    expect(() => assertDeviceShellArgv([...minted], 'test')).not.toThrow();
    expect(() => assertDeviceShellArgv(minted.slice(2), 'test')).not.toThrow();
    expect(() => assertDeviceShellArgv(['-P', '5037', ...minted], 'test')).not.toThrow();
  });

  it('keeps a long-lived minted argv accepted after the relay window has moved on', () => {
    const constant = deviceShellArgv('shell', ['dumpsys', 'window', 'windows']);
    for (let index = 0; index < 2_000; index += 1)
      deviceShellArgv('shell', ['input', 'tap', index]);
    expect(() => assertDeviceShellArgv(constant, 'test')).not.toThrow();
    expect(() => assertDeviceShellArgv([...constant], 'test')).toThrow(AppError);
  });

  it('refuses a literal or variable-built device-shell argv', () => {
    const subcommand = 'shell';
    const variableBuilt = [subcommand, 'input', 'text', 'x; reboot'];
    for (const args of [
      ['shell', 'whoami'],
      ['exec-out', 'screencap', '-p', '/never/minted'],
      variableBuilt,
    ]) {
      expect(() => assertDeviceShellArgv(args, 'test')).toThrow(AppError);
      expect(() => assertDeviceShellArgv(args, 'test')).toThrow(/deviceShellArgv/);
    }
  });
});

describe('shellQuote', () => {
  it('wraps in single quotes and escapes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe(String.raw`'it'\''s'`);
    expect(shellQuoteIfNeeded('safe_word.1')).toBe('safe_word.1');
    expect(shellQuoteIfNeeded('has space')).toBe("'has space'");
  });
});
