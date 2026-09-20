import { expect, test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { deviceShellArgv } from '@agent-device/kernel/device-shell';
import { bindAndroidAdbHostStub } from './adb-host.fixtures.ts';
import {
  createLocalAndroidAdbProvider,
  createDeviceAdbExecutor,
  resolveAndroidAdbExecutor,
  resolveAndroidAdbProvider,
  resolveAndroidTextInjector,
  resolveAndroidTouchProvider,
  resolveScopedAndroidAdbBackgroundTransport,
  withAndroidAdbProvider,
} from './adb-provider-scope.ts';
import { runAndroidHostAdb } from './adb-host.ts';
import {
  type AndroidAdbExecutorOptions,
  type AndroidAdbExecutorResult,
  type AndroidAdbProvider,
  androidAdbHostTarget,
  androidAdbInvocation,
  androidAdbSerialTarget,
  parseAndroidAdbArgv,
  serializeAndroidAdbInvocation,
  type AndroidAdbInvocation,
} from './adb-transport.ts';

const DEVICE: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};
const OTHER: DeviceInfo = { ...DEVICE, id: 'emulator-5556' };

const ok = (): AndroidAdbExecutorResult => ({ exitCode: 0, stdout: '', stderr: '' });

/** The device the host port was addressed to, and the argv it will run for that device. */
function invokedSerial(invocation: AndroidAdbInvocation): string {
  if (invocation.target.selector.kind !== 'serial') {
    throw new Error('expected a device-scoped adb invocation');
  }
  return invocation.target.selector.serial;
}

/** One host-route call as the scope left it: argv, the addressing's server, the option's server. */
function hostCall(invocation: AndroidAdbInvocation, options?: AndroidAdbExecutorOptions) {
  return {
    args: invokedArgv(invocation),
    serverPort: invokedServerPort(invocation),
    optionServerPort: options?.serverPort,
  };
}

/** A host call the lease answered for: this scope's serial, the lease's server, no option port. */
function scoped(serial: string, ...command: string[]) {
  return { args: ['-s', serial, ...command], serverPort: 15_037, optionServerPort: undefined };
}

function invokedArgv(invocation: AndroidAdbInvocation): string[] {
  return serializeAndroidAdbInvocation({
    ...invocation,
    target: { ...invocation.target, server: { kind: 'ambient' } },
  });
}

test('resolution answers from the installed scope for the matching serial only', async () => {
  bindAndroidAdbHostStub({
    execAdb: async (invocation) => {
      throw new Error(`local adb must not run in this test (serial ${invokedSerial(invocation)})`);
    },
  });
  const provider: AndroidAdbProvider = {
    exec: async () => ok(),
    text: async () => {},
  };

  await withAndroidAdbProvider(provider, { serial: DEVICE.id }, async () => {
    await expect(resolveAndroidAdbExecutor(DEVICE)([])).resolves.toEqual(ok());
    expect(resolveAndroidTextInjector(DEVICE)).toBeDefined();
    expect(resolveScopedAndroidAdbBackgroundTransport(DEVICE)).toEqual({
      mode: 'transport-composed',
    });

    // A different serial never routes into this scope's provider.
    expect(resolveAndroidTextInjector(OTHER)).toBeUndefined();
    expect(resolveScopedAndroidAdbBackgroundTransport(OTHER)).toEqual({ mode: 'local' });
  });
});

test('outside any scope, resolution falls back to host adb for the device serial', async () => {
  const serialCalls: Array<[string, readonly string[]]> = [];
  bindAndroidAdbHostStub({
    execAdb: async (invocation) => {
      serialCalls.push([invokedSerial(invocation), invocation.command]);
      return ok();
    },
  });

  await resolveAndroidAdbExecutor(DEVICE)(deviceShellArgv('adb', 'shell', ['echo', 'ok']));
  const provider = resolveAndroidAdbProvider(DEVICE);
  await provider.exec(deviceShellArgv('adb', 'shell', ['echo', 'again']));

  expect(serialCalls).toEqual([
    ['emulator-5554', ['shell', 'echo', 'ok']],
    ['emulator-5554', ['shell', 'echo', 'again']],
  ]);
});

test('the installed override routes only normalized device-scoped adb calls to the provider', async () => {
  bindAndroidAdbHostStub();
  const providerCalls: (readonly string[])[] = [];
  const provider: AndroidAdbProvider = {
    exec: async (args) => {
      providerCalls.push(args);
      return ok();
    },
  };

  // An override-capturing host observes the scope's routing decisions directly.
  let captured:
    | ((cmd: string, args: string[], options: object) => Promise<unknown> | undefined)
    | undefined;
  bindAndroidAdbHostStub({
    withAdbCommandExecutorOverride: async (override, fn) => {
      captured = override;
      return await fn();
    },
  });
  await withAndroidAdbProvider(provider, { serial: DEVICE.id }, async () => {
    expect(captured?.('adb', ['-s', DEVICE.id, 'shell', 'ls'], {})).toBeDefined();
    expect(captured?.('adb', ['-s', OTHER.id, 'shell', 'ls'], {})).toBeUndefined();
    expect(captured?.('adb', ['devices'], {})).toBeUndefined();
    expect(captured?.('emulator', ['-list-avds'], {})).toBeUndefined();
  });
  expect(providerCalls).toEqual([['shell', 'ls']]);
});

test('a managed port scope refuses global options the provider cannot restate', async () => {
  const providerCalls: (readonly string[])[] = [];
  const provider: AndroidAdbProvider = {
    exec: async (args) => {
      providerCalls.push(args);
      return ok();
    },
  };
  const capture = async (scope: { serial: string; serverPort?: number }, args: string[]) => {
    let captured:
      | ((cmd: string, args: string[], options: object) => Promise<unknown> | undefined)
      | undefined;
    bindAndroidAdbHostStub({
      withAdbCommandExecutorOverride: async (override, fn) => {
        captured = override;
        return await fn();
      },
    });
    await withAndroidAdbProvider(provider, scope, async () => {
      captured?.('adb', args, {});
    });
  };

  // A private adb server cannot carry a caller's `-t`, so the call is refused and the provider
  // never answers for an addressing set it did not choose.
  await expect(
    capture({ serial: DEVICE.id, serverPort: 15_037 }, [
      '-t',
      '42',
      '-s',
      DEVICE.id,
      'shell',
      'ls',
    ]),
  ).rejects.toMatchObject({ details: { reason: 'managed-device-transport-mismatch' } });
  expect(providerCalls).toEqual([]);

  // A port typed into argv names a server the provider cannot address, so the server rule refuses
  // it here — not the host-global rule, which is why the port has to parse.
  providerCalls.length = 0;
  await expect(
    capture({ serial: DEVICE.id, serverPort: 15_037 }, [
      '-P',
      '9999',
      '-s',
      DEVICE.id,
      'shell',
      'ls',
    ]),
  ).rejects.toThrowError(/cannot select another server/);
  expect(providerCalls).toEqual([]);

  // The server this lease holds is the one port the provider may be handed a request for, argv
  // included, and the request still travels as the caller wrote it.
  await capture({ serial: DEVICE.id, serverPort: 15_037 }, [
    '-P',
    '15037',
    '-s',
    DEVICE.id,
    'shell',
    'ls',
  ]);
  expect(providerCalls).toEqual([['-P', '15037', 'shell', 'ls']]);

  // Without a lease the caller's own adb invocation is what runs, globals and all: the provider
  // receives the request with only this scope's `-s` pair removed, and no server rule applies.
  providerCalls.length = 0;
  await capture({ serial: DEVICE.id }, ['-t', '42', '-s', DEVICE.id, 'shell', 'ls']);
  await capture({ serial: DEVICE.id }, ['-P', '9999', '-s', DEVICE.id, 'shell', 'ls']);
  expect(providerCalls).toEqual([
    ['-t', '42', 'shell', 'ls'],
    ['-P', '9999', 'shell', 'ls'],
  ]);
});

test('the provider receives the caller request with only the scope serial removed', async () => {
  const providerCalls: (readonly string[])[] = [];
  const hostCalls: ReturnType<typeof hostCall>[] = [];
  const provider: AndroidAdbProvider = {
    exec: async (args) => {
      providerCalls.push(args);
      return ok();
    },
  };
  let captured:
    | ((cmd: string, args: string[], options: object) => Promise<unknown> | undefined)
    | undefined;
  bindAndroidAdbHostStub({
    execAdb: async (invocation, options) => {
      hostCalls.push(hostCall(invocation, options));
      return ok();
    },
    withAdbCommandExecutorOverride: async (override, fn) => {
      captured = override;
      return await fn();
    },
  });

  await withAndroidAdbProvider(provider, { serial: DEVICE.id, serverPort: 15_037 }, async () => {
    // A readiness token is part of the request the provider must honor, not addressing it owns,
    // so it travels ahead of the command instead of being parsed away.
    captured?.('adb', ['-s', DEVICE.id, 'wait-for-device', 'shell', 'getprop'], {});
    // A call that addresses no device is not the provider's to answer as a device command.
    captured?.('adb', ['get-state'], {});
  });
  // A transport global under a lease is refused by the test above, not restated here.
  await withAndroidAdbProvider(provider, { serial: DEVICE.id }, async () => {
    captured?.('adb', ['-d', '-s', DEVICE.id, 'shell', 'getprop'], {});
  });

  expect(providerCalls).toEqual([
    ['wait-for-device', 'shell', 'getprop'],
    ['-d', 'shell', 'getprop'],
  ]);
  // A server-level command addresses no device, so the lease answers it on its own transport.
  expect(hostCalls).toEqual([scoped(DEVICE.id, 'get-state')]);
});

test('a managed port scope rejects foreign serials before host adb execution', async () => {
  const hostCalls: ReturnType<typeof hostCall>[] = [];
  bindAndroidAdbHostStub({
    execAdb: async (invocation, options) => {
      hostCalls.push(hostCall(invocation, options));
      return ok();
    },
  });

  await withAndroidAdbProvider(
    { exec: async () => ok() },
    { serial: DEVICE.id, serverPort: 15_037 },
    async () => {
      await runAndroidHostAdb(parseAndroidAdbArgv(['devices']));
      await runAndroidHostAdb(
        androidAdbInvocation(androidAdbHostTarget(), deviceShellArgv('adb', 'shell', ['id'])),
        { env: { ANDROID_SERIAL: OTHER.id } },
      );
      await runAndroidHostAdb(
        androidAdbInvocation(
          androidAdbSerialTarget(DEVICE.id),
          deviceShellArgv('adb', 'shell', ['getprop']),
        ),
      );
      await expect(
        runAndroidHostAdb(
          androidAdbInvocation(
            androidAdbSerialTarget(OTHER.id),
            deviceShellArgv('adb', 'shell', ['getprop']),
          ),
        ),
      ).rejects.toMatchObject({
        details: { reason: 'managed-device-transport-mismatch' },
      });
    },
  );
  await runAndroidHostAdb(parseAndroidAdbArgv(['devices']));

  // The lease's server rides in the addressing, so no per-call option can move it afterwards.
  expect(hostCalls).toEqual([
    scoped(DEVICE.id, 'devices'),
    scoped(DEVICE.id, 'shell', 'id'),
    scoped(DEVICE.id, 'shell', 'getprop'),
    { args: ['devices'], serverPort: undefined, optionServerPort: undefined },
  ]);
});

test('a managed port scope classifies absolute adb commands and preserves the default boundary', async () => {
  const providerCalls: (readonly string[])[] = [];
  const hostCalls: (readonly string[])[] = [];
  let captured:
    | ((cmd: string, args: string[], options: object) => Promise<unknown> | undefined)
    | undefined;
  bindAndroidAdbHostStub({
    execAdb: async (invocation) => {
      hostCalls.push(invokedArgv(invocation));
      return ok();
    },
    withAdbCommandExecutorOverride: async (override, fn) => {
      captured = override;
      return await fn();
    },
  });

  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        providerCalls.push(args);
        return ok();
      },
    },
    { serial: DEVICE.id, serverPort: 15_037 },
    async () => {
      const global = captured?.('/opt/android-sdk/platform-tools/adb', ['devices', '-l'], {});
      const matching = captured?.(
        '/opt/android-sdk/platform-tools/adb',
        ['-s', DEVICE.id, 'shell', 'ls'],
        {},
      );
      expect(() => captured?.('adb', ['-s', OTHER.id, 'shell', 'ls'], {})).toThrowError(
        expect.objectContaining({ details: { reason: 'managed-device-transport-mismatch' } }),
      );
      expect(captured?.('emulator', ['-list-avds'], {})).toBeUndefined();
      expect(global).toBeDefined();
      expect(matching).toBeDefined();
      await global;
      await matching;
    },
  );

  expect(hostCalls).toEqual([['-s', DEVICE.id, 'devices', '-l']]);
  expect(providerCalls).toEqual([['shell', 'ls']]);
});

test('managed port scopes refuse foreign device resolvers before returning a local transport', async () => {
  bindAndroidAdbHostStub();
  await withAndroidAdbProvider(
    { exec: async () => ok() },
    { serial: DEVICE.id, serverPort: 15_037 },
    async () => {
      for (const resolve of [
        resolveAndroidAdbExecutor,
        resolveAndroidAdbProvider,
        resolveScopedAndroidAdbBackgroundTransport,
        resolveAndroidTextInjector,
        resolveAndroidTouchProvider,
      ]) {
        expect(() => resolve(OTHER)).toThrowError(
          expect.objectContaining({ details: { reason: 'managed-device-transport-mismatch' } }),
        );
      }
    },
  );
});

test('private-port execution contains local transports constructed before entering the scope', async () => {
  const calls: Array<{ serial: string; serverPort?: number }> = [];
  bindAndroidAdbHostStub({
    execAdb: async (invocation, options) => {
      calls.push({
        serial: invokedSerial(invocation),
        serverPort: options?.serverPort ?? invokedServerPort(invocation),
      });
      return ok();
    },
    spawnAdb: (invocation, options) => {
      calls.push({
        serial: invokedSerial(invocation),
        serverPort: options?.serverPort ?? invokedServerPort(invocation),
      });
      return undefined as never;
    },
  });
  const matching = createLocalAndroidAdbProvider(DEVICE);
  const foreign = createLocalAndroidAdbProvider(OTHER);
  const wrongPort = createDeviceAdbExecutor(DEVICE, { serverPort: 15_038 });
  await withAndroidAdbProvider(
    { exec: async () => ok() },
    { serial: DEVICE.id, serverPort: 15_037 },
    async () => {
      await matching.exec(deviceShellArgv('adb', 'shell', ['id']));
      matching.spawn?.(['logcat']);
      await expect(foreign.exec(deviceShellArgv('adb', 'shell', ['id']))).rejects.toMatchObject({
        details: { reason: 'managed-device-transport-mismatch' },
      });
      expect(() => foreign.spawn?.(['logcat'])).toThrowError(
        expect.objectContaining({ details: { reason: 'managed-device-transport-mismatch' } }),
      );
      await expect(wrongPort(deviceShellArgv('adb', 'shell', ['id']))).rejects.toMatchObject({
        details: { reason: 'managed-device-transport-mismatch' },
      });
    },
  );
  expect(calls).toEqual([
    { serial: DEVICE.id, serverPort: 15_037 },
    { serial: DEVICE.id, serverPort: 15_037 },
  ]);
});

test('a leased host transport answers for its own server, and refuses one a call names', async () => {
  const hostCalls: ReturnType<typeof hostCall>[] = [];
  bindAndroidAdbHostStub({
    execAdb: async (invocation, options) => {
      hostCalls.push(hostCall(invocation, options));
      return ok();
    },
  });

  await withAndroidAdbProvider(
    { exec: async () => ok() },
    { serial: DEVICE.id, serverPort: 15_037 },
    async () => {
      await runAndroidHostAdb(parseAndroidAdbArgv(['devices']), { serverPort: 15_037 });
      await expect(
        runAndroidHostAdb(parseAndroidAdbArgv(['devices']), { serverPort: 9_999 }),
      ).rejects.toMatchObject({
        details: { reason: 'managed-device-transport-mismatch' },
      });
    },
  );

  expect(hostCalls).toEqual([scoped(DEVICE.id, 'devices')]);
});

test('a device route answers for the server it was built with, not one a call names', async () => {
  const calls: ReturnType<typeof hostCall>[] = [];
  bindAndroidAdbHostStub({
    execAdb: async (invocation, options) => {
      calls.push(hostCall(invocation, options));
      return ok();
    },
    spawnAdb: (invocation, options) => {
      calls.push(hostCall(invocation, options));
      return undefined as never;
    },
  });

  // With no lease the port the route was built with is the one it addresses, so a per-call option
  // is not a second channel that can move the same request onto another adb server.
  const route = createLocalAndroidAdbProvider(DEVICE, { serverPort: 15_037 });
  await route.exec(deviceShellArgv('adb', 'shell', ['id']), { serverPort: 9_999 });
  route.spawn?.(['logcat'], { serverPort: 9_999 });
  expect(calls).toEqual([scoped(DEVICE.id, 'shell', 'id'), scoped(DEVICE.id, 'logcat')]);

  // Under a lease the same request is refused rather than answered on a server the lease lost.
  calls.length = 0;
  await withAndroidAdbProvider(
    { exec: async () => ok() },
    { serial: DEVICE.id, serverPort: 15_037 },
    async () => {
      await expect(
        route.exec(deviceShellArgv('adb', 'shell', ['id']), { serverPort: 9_999 }),
      ).rejects.toMatchObject({
        details: { reason: 'managed-device-transport-mismatch' },
      });
      expect(() => route.spawn?.(['logcat'], { serverPort: 9_999 })).toThrowError(
        expect.objectContaining({ details: { reason: 'managed-device-transport-mismatch' } }),
      );
    },
  );
  expect(calls).toEqual([]);

  // A port typed into argv names the same conflict as one passed as an option, and the route has to
  // answer for it too: it is the arm that would otherwise overwrite the caller's `-P`.
  await expect(route.exec(['-P', '9999', 'getprop'])).rejects.toMatchObject({
    details: { reason: 'managed-device-transport-mismatch' },
  });
  expect(() => route.spawn?.(['-P', '9999', 'logcat'])).toThrowError(
    expect.objectContaining({ details: { reason: 'managed-device-transport-mismatch' } }),
  );
  expect(calls).toEqual([]);

  // The port this route was built with is the one it may answer for, however the caller spells it.
  await route.exec(['-P', '15037', 'getprop']);
  expect(calls).toEqual([scoped(DEVICE.id, 'getprop')]);
});

test('a managed port scope keeps shell -s arguments on the private transport', async () => {
  const hostCalls: ReturnType<typeof hostCall>[] = [];
  let captured:
    | ((cmd: string, args: string[], options: object) => Promise<unknown> | undefined)
    | undefined;
  bindAndroidAdbHostStub({
    execAdb: async (invocation, options) => {
      hostCalls.push(hostCall(invocation, options));
      return ok();
    },
    withAdbCommandExecutorOverride: async (override, fn) => {
      captured = override;
      return await fn();
    },
  });

  await withAndroidAdbProvider(
    { exec: async () => ok() },
    { serial: DEVICE.id, serverPort: 15_037 },
    async () => {
      await runAndroidHostAdb(
        androidAdbInvocation(
          androidAdbHostTarget(),
          deviceShellArgv('adb', 'shell', ['echo', '-s', OTHER.id]),
        ),
      );
      const shellCommand = captured?.('adb', ['shell', 'echo', '-s', OTHER.id], {});
      expect(shellCommand).toBeDefined();
      await shellCommand;
    },
  );

  expect(hostCalls).toEqual([
    scoped(DEVICE.id, 'shell', 'echo', '-s', OTHER.id),
    scoped(DEVICE.id, 'shell', 'echo', '-s', OTHER.id),
  ]);
});

test('a managed port scope restores the default transport after task failure', async () => {
  const ports: Array<number | undefined> = [];
  bindAndroidAdbHostStub({
    execAdb: async (invocation, options) => {
      ports.push(options?.serverPort ?? invokedServerPort(invocation));
      return ok();
    },
  });

  await expect(
    withAndroidAdbProvider(
      { exec: async () => ok() },
      { serial: DEVICE.id, serverPort: 15_037 },
      async () => {
        await runAndroidHostAdb(parseAndroidAdbArgv(['devices']));
        throw new Error('stop managed request');
      },
    ),
  ).rejects.toThrow('stop managed request');
  await runAndroidHostAdb(parseAndroidAdbArgv(['devices']));

  expect(ports).toEqual([15_037, undefined]);
});

test('a managed port scope carries its server through the local background transport', async () => {
  const spawnCalls: Array<{
    serial: string;
    args: readonly string[];
    serverPort?: number;
  }> = [];
  bindAndroidAdbHostStub({
    spawnAdb: (invocation, options) => {
      spawnCalls.push({
        serial: invokedSerial(invocation),
        args: invocation.command,
        serverPort: options?.serverPort ?? invokedServerPort(invocation),
      });
      return undefined as never;
    },
  });
  const deviceProvider = createLocalAndroidAdbProvider(DEVICE, { serverPort: 15_037 });

  await withAndroidAdbProvider(
    deviceProvider,
    { serial: DEVICE.id, serverPort: 15_037 },
    async () => {
      const transport = resolveScopedAndroidAdbBackgroundTransport(DEVICE);
      expect(transport.mode).toBe('transport-composed');
      if (transport.mode === 'transport-composed') {
        transport.spawn?.(['logcat', '-v', 'threadtime']);
      }
    },
  );

  expect(spawnCalls).toEqual([
    { serial: DEVICE.id, args: ['logcat', '-v', 'threadtime'], serverPort: 15_037 },
  ]);
});

test('managed port scopes remain isolated across concurrent requests', async () => {
  const hostCalls: Array<{ serial: string; serverPort?: number }> = [];
  bindAndroidAdbHostStub({
    execAdb: async (invocation, options) => {
      hostCalls.push({
        serial: invokedSerial(invocation),
        serverPort: options?.serverPort ?? invokedServerPort(invocation),
      });
      await Promise.resolve();
      return ok();
    },
  });

  await Promise.all([
    withAndroidAdbProvider(
      { exec: async () => ok() },
      { serial: DEVICE.id, serverPort: 15_037 },
      async () =>
        await runAndroidHostAdb(
          androidAdbInvocation(
            androidAdbSerialTarget(DEVICE.id),
            deviceShellArgv('adb', 'shell', ['id']),
          ),
        ),
    ),
    withAndroidAdbProvider(
      { exec: async () => ok() },
      { serial: OTHER.id, serverPort: 15_038 },
      async () =>
        await runAndroidHostAdb(
          androidAdbInvocation(
            androidAdbSerialTarget(OTHER.id),
            deviceShellArgv('adb', 'shell', ['id']),
          ),
        ),
    ),
  ]);

  expect(hostCalls).toEqual([
    { serial: DEVICE.id, serverPort: 15_037 },
    { serial: OTHER.id, serverPort: 15_038 },
  ]);
});

function invokedServerPort(invocation: AndroidAdbInvocation): number | undefined {
  return invocation.target.server.kind === 'port' ? invocation.target.server.port : undefined;
}
