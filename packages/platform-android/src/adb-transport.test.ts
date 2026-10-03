import { describe, expect, it } from 'vitest';
import {
  ADB_GLOBAL_OPTIONS,
  ADB_MANAGED_FORBIDDEN_COMMANDS,
  ADB_WAIT_STATES,
  ADB_WAIT_TRANSPORTS,
  androidAdbHostTarget,
  androidAdbInvocation,
  androidAdbPayloadWithoutSerial,
  androidAdbSerialTarget,
  type AndroidAdbExecutorOptions,
  androidManagedAdbEnvironment,
  lowerAndroidAdbInvocation,
  requireSameAndroidAdbServer,
  applyManagedAndroidAdbServer,
  parseAndroidAdbArgv,
  adoptAndroidAdbSerial,
  requireAndroidAdbServerPort,
  requireManagedAndroidAdbCommand,
  requireManagedAndroidAdbSerial,
  serializeAndroidAdbInvocation,
} from './adb-transport.ts';

describe('adb argv grammar', () => {
  it('carries the arity adb documents for every global option', () => {
    expect(ADB_GLOBAL_OPTIONS).toEqual({
      '-a': 0,
      '-d': 0,
      '-e': 0,
      '-s': 1,
      '-t': 1,
      '-H': 1,
      '-P': 1,
      '-L': 1,
      '--one-device': 1,
      '--exit-on-write-error': 0,
    });
  });

  it('reads every transport-and-state product adb documents as addressing', () => {
    const forms = ADB_WAIT_TRANSPORTS.flatMap((transport) =>
      ADB_WAIT_STATES.map((state) => `wait-for-${transport}${state}`),
    );
    expect(forms).toHaveLength(20);
    for (const token of forms) {
      expect(parseAndroidAdbArgv([token, 'get-state']).target.waitFor).toBe(token);
    }
  });

  it('hands a readiness token adb cannot parse to the command guard, not to addressing', () => {
    // adb still waits for this token, so the grammar must not claim it, and must not lose it.
    const invocation = parseAndroidAdbArgv(['wait-for-magic', 'get-state']);
    expect(invocation.target.waitFor).toBeUndefined();
    expect(invocation.target.hostGlobals).toEqual(['wait-for-magic']);
    expect(invocation.command).toEqual(['get-state']);
  });

  it('names server and transport lifecycle as forbidden under a managed transport', () => {
    expect([...ADB_MANAGED_FORBIDDEN_COMMANDS].sort()).toEqual(
      [
        'attach',
        'connect',
        'detach',
        'disconnect',
        'fork-server',
        'kill-server',
        'nodaemon',
        'pair',
        'reconnect',
        'server',
        'start-server',
      ].sort(),
    );
  });
});

describe('parseAndroidAdbArgv', () => {
  it('addresses no device when the argv named none', () => {
    const invocation = parseAndroidAdbArgv(['devices']);
    expect(invocation.target.selector).toEqual({ kind: 'unspecified' });
    expect(invocation.command).toEqual(['devices']);
  });

  it('reads the serial an adb invocation addresses itself by', () => {
    const invocation = parseAndroidAdbArgv(['-s', 'emulator-5554', 'shell', 'id']);
    expect(invocation.target).toEqual({
      selector: { kind: 'serial', serial: 'emulator-5554' },
      server: { kind: 'ambient' },
    });
    expect(invocation.command).toEqual(['shell', 'id']);
  });

  it('hands an addressing-free command through by reference', () => {
    const argv = ['shell', 'input', 'tap', '10', '20'];
    const invocation = parseAndroidAdbArgv(argv);
    expect(invocation.command).toBe(argv);
    expect(invocation.rawArgv).toBeUndefined();
  });

  it('keeps global options it does not own out of the command', () => {
    const invocation = parseAndroidAdbArgv(['-t', '42', '-s', 'A', 'shell', 'id']);
    expect(invocation.target.selector).toEqual({ kind: 'serial', serial: 'A' });
    expect(invocation.target.hostGlobals).toEqual(['-t', '42']);
    expect(invocation.command).toEqual(['shell', 'id']);
  });

  it('stops at an option whose shape it cannot trust', () => {
    const invocation = parseAndroidAdbArgv(['-s', 'A', 'shell', '-s', 'B']);
    expect(invocation.command).toEqual(['shell', '-s', 'B']);
  });

  it('lets a second serial keep its winning position on the way out', () => {
    const invocation = parseAndroidAdbArgv(['-s', 'A', '-s', 'B', 'shell', 'id']);
    expect(invocation.target.selector).toEqual({ kind: 'serial', serial: 'A' });
    expect(invocation.target.hostGlobals).toEqual(['-s', 'B']);
  });

  it('reads a server port and a readiness request as addressing', () => {
    const invocation = parseAndroidAdbArgv(['-P', '5038', 'wait-for-usb-device', 'get-state']);
    expect(invocation.target.server).toEqual({ kind: 'port', port: 5038 });
    expect(invocation.target.waitFor).toBe('wait-for-usb-device');
    expect(invocation.command).toEqual(['get-state']);
  });

  it('leaves a malformed port to the process', () => {
    const invocation = parseAndroidAdbArgv(['-P', 'nope', 'shell', 'id']);
    expect(invocation.target.server).toEqual({ kind: 'ambient' });
    expect(invocation.target.hostGlobals).toEqual(['-P', 'nope']);
  });

  it('remembers the argv an ambient request was spelled with', () => {
    const argv = ['-H', '10.0.0.8', '-P', '5037', '-s', 'A', 'shell', 'id'];
    const invocation = parseAndroidAdbArgv(argv);
    expect(invocation.rawArgv).toBe(argv);
    expect(serializeAndroidAdbInvocation(invocation)).toEqual(argv);
  });

  it('never rewrites a payload it only read', () => {
    const argv = ['-s', 'A', 'shell', 'wm', 'size'];
    expect(serializeAndroidAdbInvocation(parseAndroidAdbArgv(argv))).toEqual(argv);
    expect(argv).toEqual(['-s', 'A', 'shell', 'wm', 'size']);
  });

  it('drops a repeated serial that asks for nothing the first one did not say', () => {
    const invocation = parseAndroidAdbArgv(['-s', 'A', '-s', 'A', 'shell', 'id']);
    expect(invocation.target.selector).toEqual({ kind: 'serial', serial: 'A' });
    expect(invocation.target.hostGlobals).toBeUndefined();
  });

  it('keeps a second readiness token as a global one typed wait cannot answer for', () => {
    const invocation = parseAndroidAdbArgv(['wait-for-device', 'wait-for-usb-device', 'get-state']);
    expect(invocation.target.waitFor).toBe('wait-for-device');
    expect(invocation.target.hostGlobals).toEqual(['wait-for-usb-device']);
    expect(invocation.command).toEqual(['get-state']);
  });
});

describe('androidAdbPayloadWithoutSerial', () => {
  it('carries a readiness token to whoever is asked to run the command', () => {
    expect(
      androidAdbPayloadWithoutSerial(['-s', 'A', 'wait-for-device', 'shell', 'getprop'], 'A'),
    ).toEqual(['wait-for-device', 'shell', 'getprop']);
  });

  it('leaves globals the caller spelled where the caller spelled them', () => {
    expect(androidAdbPayloadWithoutSerial(['-t', '42', '-s', 'A', 'shell', 'id'], 'A')).toEqual([
      '-t',
      '42',
      'shell',
      'id',
    ]);
  });

  it('answers undefined for a request addressing another device, none, or only a payload -s', () => {
    expect(androidAdbPayloadWithoutSerial(['-s', 'B', 'shell', 'id'], 'A')).toBeUndefined();
    expect(androidAdbPayloadWithoutSerial(['get-state'], 'A')).toBeUndefined();
    expect(androidAdbPayloadWithoutSerial(['shell', 'echo', '-s', 'A'], 'A')).toBeUndefined();
  });
});

describe('requireSameAndroidAdbServer', () => {
  it('keeps the server one layer already owns', () => {
    expect(requireSameAndroidAdbServer(15_037, undefined)).toBe(15_037);
    expect(requireSameAndroidAdbServer(undefined, 15_037)).toBe(15_037);
    expect(requireSameAndroidAdbServer(15_037, 15_037)).toBe(15_037);
    expect(requireSameAndroidAdbServer(undefined, undefined)).toBeUndefined();
  });

  it('refuses a second name for the server, whoever asked', () => {
    expect(() => requireSameAndroidAdbServer(15_037, 9_999)).toThrowError(
      expect.objectContaining({
        code: 'COMMAND_FAILED',
        message: 'Managed ADB transport cannot select another server.',
        details: expect.objectContaining({ reason: 'managed-device-transport-mismatch' }),
      }),
    );
    expect(() => requireSameAndroidAdbServer(9_999, 15_037)).toThrowError(
      expect.objectContaining({ details: { reason: 'managed-device-transport-mismatch' } }),
    );
  });
});

describe('lowerAndroidAdbInvocation', () => {
  it('carries the owned server into argv and environment, and drops the option channel', () => {
    const options: AndroidAdbExecutorOptions = { serverPort: 15_037, timeoutMs: 5_000 };
    const lowered = lowerAndroidAdbInvocation(
      androidAdbInvocation(androidAdbSerialTarget('emulator-5554', 15_037), ['shell', 'id']),
      options,
      { ANDROID_ADB_SERVER_PORT: '5037', ADB_SERVER_SOCKET: 'tcp:elsewhere:5037' },
    );

    expect(lowered.args).toEqual(['-P', '15037', '-s', 'emulator-5554', 'shell', 'id']);
    expect(lowered.options).toEqual({
      timeoutMs: 5_000,
      env: {
        ANDROID_ADB_SERVER_PORT: '15037',
        ADB_SERVER_SOCKET: undefined,
        ANDROID_ADB_SERVER_ADDRESS: '127.0.0.1',
      },
    });
  });

  it('leaves an ambient request to the process environment it inherited', () => {
    const options: AndroidAdbExecutorOptions = { timeoutMs: 5_000 };
    const lowered = lowerAndroidAdbInvocation(
      parseAndroidAdbArgv(['-s', 'emulator-5554', 'shell', 'id']),
      options,
      { ANDROID_ADB_SERVER_PORT: '5037' },
    );

    expect(lowered.args).toEqual(['-s', 'emulator-5554', 'shell', 'id']);
    expect(lowered.options).toEqual({ timeoutMs: 5_000 });
  });
});

describe('requireAndroidAdbServerPort', () => {
  it('answers from the port the addressing owns', () => {
    const invocation = androidAdbInvocation(androidAdbSerialTarget('A', 15_037), ['shell', 'id']);
    expect(requireAndroidAdbServerPort(invocation, { serverPort: 15_037 })).toBe(15_037);
  });

  it('refuses a per-call port that would move an owned server', () => {
    const invocation = androidAdbInvocation(androidAdbSerialTarget('A', 15_037), ['shell', 'id']);
    expect(() => requireAndroidAdbServerPort(invocation, { serverPort: 9_999 })).toThrowError(
      expect.objectContaining({
        code: 'COMMAND_FAILED',
        details: expect.objectContaining({ reason: 'managed-device-transport-mismatch' }),
      }),
    );
  });

  it('follows a per-call port while nothing owns one', () => {
    const invocation = parseAndroidAdbArgv(['shell', 'id']);
    expect(requireAndroidAdbServerPort(invocation, { serverPort: 9_999 })).toBe(9_999);
    expect(requireAndroidAdbServerPort(invocation)).toBeUndefined();
  });
});

describe('androidAdbHostTarget', () => {
  it('addresses a server-level command without any device option', () => {
    const invocation = androidAdbInvocation(androidAdbHostTarget(), [
      'disconnect',
      '127.0.0.1:5037',
    ]);
    expect(serializeAndroidAdbInvocation(invocation)).toEqual(['disconnect', '127.0.0.1:5037']);
  });

  it('is what an argv naming neither device nor server reads as', () => {
    expect(parseAndroidAdbArgv(['devices']).target).toEqual(androidAdbHostTarget());
  });
});

describe('serializeAndroidAdbInvocation', () => {
  it('emits owned addressing ahead of the command in adb order', () => {
    const invocation = androidAdbInvocation(
      {
        selector: { kind: 'serial', serial: 'A' },
        server: { kind: 'port', port: 5038 },
        waitFor: 'wait-for-device',
        hostGlobals: ['-a'],
      },
      ['shell', 'id'],
    );
    expect(serializeAndroidAdbInvocation(invocation)).toEqual([
      '-P',
      '5038',
      '-s',
      'A',
      '-a',
      'wait-for-device',
      'shell',
      'id',
    ]);
  });

  it('appends a payload that looks like addressing without re-reading it', () => {
    const command = ['-s', 'B', 'shell', 'id'];
    const invocation = androidAdbInvocation(androidAdbSerialTarget('A'), command);
    expect(serializeAndroidAdbInvocation(invocation)).toEqual([
      '-s',
      'A',
      '-s',
      'B',
      'shell',
      'id',
    ]);
    expect(command).toEqual(['-s', 'B', 'shell', 'id']);
  });
});

describe('adoptAndroidAdbSerial', () => {
  it('addresses an ambient target at the device it was built for', () => {
    const target = adoptAndroidAdbSerial(
      parseAndroidAdbArgv(['shell', 'getprop']).target,
      'emulator-5554',
    );
    expect(
      serializeAndroidAdbInvocation(androidAdbInvocation(target, ['shell', 'getprop'])),
    ).toEqual(['-s', 'emulator-5554', 'shell', 'getprop']);
  });
});

describe('applyManagedAndroidAdbServer', () => {
  it('rewrites addressing and carries the command by reference', () => {
    const command = ['shell', 'dumpsys', 'window'];
    const invocation = applyManagedAndroidAdbServer(
      androidAdbInvocation(androidAdbSerialTarget('A'), command),
      { port: 5039 },
    );
    expect(invocation.command).toBe(command);
    expect(serializeAndroidAdbInvocation(invocation)).toEqual([
      '-P',
      '5039',
      '-s',
      'A',
      'shell',
      'dumpsys',
      'window',
    ]);
  });

  it('refuses a port the caller typed for another server', () => {
    expect(() =>
      applyManagedAndroidAdbServer(parseAndroidAdbArgv(['-P', '5037', '-s', 'A', 'shell', 'id']), {
        port: 5039,
      }),
    ).toThrowError(/cannot select another server/);
  });

  it('accepts a port the caller typed for the server the lease already holds', () => {
    const invocation = applyManagedAndroidAdbServer(
      parseAndroidAdbArgv(['-P', '5039', '-s', 'A', 'shell', 'id']),
      { port: 5039 },
    );
    expect(invocation.rawArgv).toBeUndefined();
    expect(serializeAndroidAdbInvocation(invocation)).toEqual([
      '-P',
      '5039',
      '-s',
      'A',
      'shell',
      'id',
    ]);
  });

  it('refuses a host global the managed transport cannot restate', () => {
    expect(() =>
      applyManagedAndroidAdbServer(parseAndroidAdbArgv(['-t', '42', 'shell', 'id']), {
        port: 5039,
      }),
    ).toThrowError(/cannot select another target/);
  });

  it('refuses another device', () => {
    expect(() => requireManagedAndroidAdbSerial(androidAdbSerialTarget('B'), 'A')).toThrowError(
      /cannot address another device/,
    );
    expect(requireManagedAndroidAdbSerial(androidAdbSerialTarget('A'), 'A').selector).toEqual({
      kind: 'serial',
      serial: 'A',
    });
  });
});

describe('requireManagedAndroidAdbCommand', () => {
  it('answers for the command behind any readiness token', () => {
    requireManagedAndroidAdbCommand(['wait-for-device', 'shell', 'id']);
    expect(() => requireManagedAndroidAdbCommand(['kill-server'])).toThrowError(
      /cannot select another target/,
    );
    expect(() =>
      requireManagedAndroidAdbCommand(['wait-for-recovery', 'kill-server']),
    ).toThrowError(/cannot select another target/);
    expect(() => requireManagedAndroidAdbCommand(['wait-for-magic', 'start-server'])).toThrowError(
      /cannot select another target/,
    );
  });
});

describe('androidManagedAdbEnvironment', () => {
  it('points a private server at loopback and clears a socket', () => {
    const environment = androidManagedAdbEnvironment(
      androidAdbSerialTarget('A', 5039),
      { ANDROID_ADB_SERVER_PORT: '5037', ADB_SERVER_SOCKET: 'tcp:5037' },
      { ...process.env, PATH: '/bin' },
    );
    expect(environment?.ANDROID_ADB_SERVER_PORT).toBe('5039');
    expect(environment?.ANDROID_ADB_SERVER_ADDRESS).toBe('127.0.0.1');
    expect(environment?.ADB_SERVER_SOCKET).toBeUndefined();
    expect(environment?.PATH).toBe('/bin');
  });

  it('leaves an ambient transport alone', () => {
    const base = { ANDROID_ADB_SERVER_PORT: '5037' };
    expect(androidManagedAdbEnvironment(androidAdbSerialTarget('A'), {}, base)).toBe(base);
  });
});
