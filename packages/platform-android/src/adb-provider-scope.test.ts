import { expect, onTestFinished, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { deviceShellArgv } from '@agent-device/kernel/device-shell';
import { bindAndroidAdbHostStub } from './adb-host.fixtures.ts';
import {
  createLocalAndroidAdbProvider,
  createStayedOfflineDevices,
  createDeviceAdbExecutor,
  resolveAndroidAdbExecutor,
  resolveAndroidAdbProvider,
  resolveAndroidTextInjector,
  resolveScopedAndroidAdbBackgroundTransport,
  withAndroidAdbProvider,
} from './adb-provider-scope.ts';
import {
  type AndroidAdbExecutorOptions,
  type AndroidAdbExecutorResult,
  type AndroidAdbProvider,
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

/** A host call on the private server 15037: the server on the addressing, no option port. */
function onPrivateServer(serial: string, ...command: string[]) {
  return { args: ['-s', serial, ...command], serverPort: 15_037, optionServerPort: undefined };
}

function invokedArgv(invocation: AndroidAdbInvocation): readonly string[] {
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

/** Whether a host call is the readiness wait adb models as addressing, not as a command. */
function isWaitForDevice(invocation: AndroidAdbInvocation): boolean {
  return invokedArgv(invocation).includes('wait-for-device');
}

test('a command adb refused as device offline waits for the device and runs once more', async () => {
  const calls: Array<{ args: string[]; timeoutMs?: number }> = [];
  let offline = true;
  bindAndroidAdbHostStub({
    execAdb: async (invocation, options) => {
      calls.push({ args: [...invokedArgv(invocation)], timeoutMs: options?.timeoutMs });
      if (isWaitForDevice(invocation)) {
        offline = false;
        return ok();
      }
      return offline
        ? { exitCode: 1, stdout: '', stderr: 'adb: device offline' }
        : { exitCode: 0, stdout: 'installed', stderr: '' };
    },
  });

  const result = await createDeviceAdbExecutor(DEVICE)(['install', '-r', 'helper.apk'], {
    allowFailure: true,
  });

  expect(result).toEqual({ exitCode: 0, stdout: 'installed', stderr: '' });
  expect(calls).toEqual([
    { args: ['-s', 'emulator-5554', 'install', '-r', 'helper.apk'], timeoutMs: undefined },
    { args: ['-s', 'emulator-5554', 'wait-for-device'], timeoutMs: 15_000 },
    { args: ['-s', 'emulator-5554', 'install', '-r', 'helper.apk'], timeoutMs: undefined },
  ]);
});

test('a thrown device-offline refusal gets the same one retry', async () => {
  const commands: string[] = [];
  bindAndroidAdbHostStub({
    execAdb: async (invocation) => {
      if (isWaitForDevice(invocation)) {
        commands.push('wait-for-device');
        return ok();
      }
      commands.push(invocation.command[0] ?? '');
      if (commands.length === 1) {
        throw new AppError('COMMAND_FAILED', 'adb exited with code 1', {
          exitCode: 1,
          stdout: '',
          stderr: 'error: device offline',
        });
      }
      return ok();
    },
  });

  await expect(createDeviceAdbExecutor(DEVICE)(['install', 'helper.apk'])).resolves.toEqual(ok());
  expect(commands).toEqual(['install', 'wait-for-device', 'install']);
});

test('the wait and the retry share the caller timeout', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const timeouts: Array<number | undefined> = [];
  let offline = true;
  bindAndroidAdbHostStub({
    execAdb: async (invocation, options) => {
      timeouts.push(options?.timeoutMs);
      if (isWaitForDevice(invocation)) {
        vi.setSystemTime(Date.now() + 1_500);
        offline = false;
      }
      return offline ? { exitCode: 1, stdout: '', stderr: 'adb: device offline' } : ok();
    },
  });

  await createDeviceAdbExecutor(DEVICE)(['install', 'helper.apk'], {
    allowFailure: true,
    timeoutMs: 4_000,
  });

  expect(timeouts).toEqual([4_000, 2_000, 2_500]);
});

test('a caller that aborts during the wait gets no retry', async () => {
  const controller = new AbortController();
  const commands: string[] = [];
  bindAndroidAdbHostStub({
    execAdb: async (invocation) => {
      if (isWaitForDevice(invocation)) {
        commands.push('wait-for-device');
        controller.abort();
        throw new AppError('COMMAND_FAILED', 'adb canceled');
      }
      commands.push(invocation.command[0] ?? '');
      return { exitCode: 1, stdout: '', stderr: 'adb: device offline' };
    },
  });

  await expect(
    createDeviceAdbExecutor(DEVICE)(['install', 'helper.apk'], {
      allowFailure: true,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(commands).toEqual(['install', 'wait-for-device']);
});

test('device output that mentions device offline is not retried', async () => {
  const commands: string[] = [];
  const outputs = [
    { exitCode: 1, stdout: 'partial', stderr: 'adb: device offline' },
    { exitCode: 1, stdout: '', stderr: 'flash: device offline, giving up' },
  ];
  bindAndroidAdbHostStub({
    execAdb: async (invocation) => {
      commands.push(isWaitForDevice(invocation) ? 'wait-for-device' : 'install');
      return outputs[commands.length - 1] ?? ok();
    },
  });
  const adb = createDeviceAdbExecutor(DEVICE);

  await adb(['install', 'helper.apk'], { allowFailure: true });
  await adb(['install', 'helper.apk'], { allowFailure: true });
  expect(commands).toEqual(['install', 'install']);
});

test('a refusal with no budget left for a wait stands', async () => {
  const commands: string[] = [];
  bindAndroidAdbHostStub({
    execAdb: async (invocation) => {
      commands.push(isWaitForDevice(invocation) ? 'wait-for-device' : 'install');
      return { exitCode: 1, stdout: '', stderr: 'adb: device offline' };
    },
  });

  const result = await createDeviceAdbExecutor(DEVICE)(['install', 'helper.apk'], {
    allowFailure: true,
    timeoutMs: 1,
  });
  expect(result.exitCode).toBe(1);
  expect(commands).toEqual(['install']);
});

test('the wait asks the same adb server and environment as the refused command', async () => {
  const calls: Array<{ wait: boolean; server: unknown; env: unknown }> = [];
  bindAndroidAdbHostStub({
    execAdb: async (invocation, options) => {
      const wait = isWaitForDevice(invocation);
      calls.push({ wait, server: invocation.target.server, env: options?.env });
      return calls.length === 1 ? { exitCode: 1, stdout: '', stderr: 'adb: device offline' } : ok();
    },
  });

  await createDeviceAdbExecutor(DEVICE)(['install', 'helper.apk'], {
    serverPort: 15_037,
    env: { ANDROID_SERIAL: 'emulator-5554' },
  });
  expect(calls.map((call) => call.wait)).toEqual([false, true, false]);
  expect(calls[1]?.server).toEqual(calls[0]?.server);
  expect(calls[1]?.env).toEqual({ ANDROID_SERIAL: 'emulator-5554' });
});

test('only a device-offline refusal is retried, and a device that stays offline stops waiting', async () => {
  const stuck: DeviceInfo = { ...DEVICE, id: 'emulator-5562' };
  const commands: string[] = [];
  let answers = false;
  let timesOut = false;
  bindAndroidAdbHostStub({
    execAdb: async (invocation) => {
      if (isWaitForDevice(invocation)) {
        commands.push('wait-for-device');
        return ok();
      }
      commands.push(invocation.command[0] ?? '');
      if (timesOut) {
        throw new AppError('COMMAND_FAILED', 'adb timed out after 10ms', {
          exitCode: -1,
          stdout: '',
          stderr: '',
          timeoutMs: 10,
        });
      }
      if (invocation.command[0] === 'uninstall') {
        return { exitCode: 1, stdout: 'Failure [DELETE_FAILED_INTERNAL_ERROR]', stderr: '' };
      }
      return answers ? ok() : { exitCode: 1, stdout: '', stderr: 'adb: device offline' };
    },
  });
  const adb = createDeviceAdbExecutor(stuck);

  await adb(['uninstall', 'com.example'], { allowFailure: true });
  expect(commands).toEqual(['uninstall']);

  commands.length = 0;
  const stillOffline = await adb(['install', 'helper.apk'], { allowFailure: true });
  expect(stillOffline.exitCode).toBe(1);
  expect(commands).toEqual(['install', 'wait-for-device', 'install']);

  commands.length = 0;
  await adb(['install', 'helper.apk'], { allowFailure: true });
  expect(commands).toEqual(['install']);

  timesOut = true;
  await expect(adb(['install', 'helper.apk'])).rejects.toMatchObject({
    details: { adbFailure: 'timeout' },
  });
  timesOut = false;
  commands.length = 0;
  await adb(['install', 'helper.apk'], { allowFailure: true });
  expect(commands).toEqual(['install']);

  answers = true;
  await adb(['install', 'helper.apk'], { allowFailure: true });
  answers = false;
  commands.length = 0;
  await adb(['install', 'helper.apk'], { allowFailure: true });
  expect(commands).toEqual(['install', 'wait-for-device', 'install']);
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
    | ((cmd: string, args: readonly string[], options: object) => Promise<unknown> | undefined)
    | undefined;
  bindAndroidAdbHostStub({
    withAdbCommandExecutorOverride: async (override, fn) => {
      captured = override;
      return await fn();
    },
  });
  await withAndroidAdbProvider(provider, { serial: DEVICE.id }, async () => {
    expect(
      captured?.('adb', deviceShellArgv('adb', 'shell', ['ls'], ['-s', DEVICE.id]), {}),
    ).toBeDefined();
    expect(captured?.('adb', ['-s', OTHER.id, 'shell', 'ls'], {})).toBeUndefined();
    expect(captured?.('adb', ['devices'], {})).toBeUndefined();
    expect(
      captured?.('/opt/android-sdk/platform-tools/adb', ['devices', '-l'], {}),
    ).toBeUndefined();
    expect(captured?.('emulator', ['-list-avds'], {})).toBeUndefined();
  });
  expect(providerCalls).toEqual([['shell', 'ls']]);
});

test('the installed override refuses a device-shell argv the funnel did not mint', async () => {
  const providerCalls: (readonly string[])[] = [];
  let captured:
    | ((cmd: string, args: readonly string[], options: object) => Promise<unknown> | undefined)
    | undefined;
  bindAndroidAdbHostStub({
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
    { serial: DEVICE.id },
    async () => {
      const joined = ['am', 'start', '-n', 'com.example/.Main;id'].join(' ');
      await expect(captured?.('adb', ['-s', DEVICE.id, 'shell', joined], {})).rejects.toMatchObject(
        { code: 'INVALID_ARGS', details: { reason: 'unguarded-device-shell-argv' } },
      );
    },
  );
  expect(providerCalls).toEqual([]);
});

test('the installed override hands the provider caller globals with only the scope serial removed', async () => {
  const providerCalls: (readonly string[])[] = [];
  const hostCalls: ReturnType<typeof hostCall>[] = [];
  let captured:
    | ((cmd: string, args: readonly string[], options: object) => Promise<unknown> | undefined)
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
  const provider: AndroidAdbProvider = {
    exec: async (args) => {
      providerCalls.push(args);
      return ok();
    },
  };

  await withAndroidAdbProvider(provider, { serial: DEVICE.id }, async () => {
    // A readiness token is part of the request the provider must honor, not addressing it owns,
    // so it travels ahead of the command instead of being parsed away.
    await captured?.(
      'adb',
      deviceShellArgv('adb', 'shell', ['getprop'], ['-s', DEVICE.id, 'wait-for-device']),
      {},
    );
    await captured?.(
      'adb',
      deviceShellArgv('adb', 'shell', ['getprop'], ['-d', '-s', DEVICE.id]),
      {},
    );
    await captured?.(
      'adb',
      deviceShellArgv('adb', 'shell', ['ls'], ['-t', '42', '-s', DEVICE.id]),
      {},
    );
    await captured?.(
      'adb',
      deviceShellArgv('adb', 'shell', ['ls'], ['-P', '9999', '-s', DEVICE.id]),
      {},
    );
    // A call that addresses no device is not the provider's to answer as a device command.
    expect(captured?.('adb', ['get-state'], {})).toBeUndefined();
  });

  expect(providerCalls).toEqual([
    ['wait-for-device', 'shell', 'getprop'],
    ['-d', 'shell', 'getprop'],
    ['-t', '42', 'shell', 'ls'],
    ['-P', '9999', 'shell', 'ls'],
  ]);
  expect(hostCalls).toEqual([]);
});

test('a device route addresses the server a call names, and refuses an argv naming another', async () => {
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
  const route = createLocalAndroidAdbProvider(DEVICE);
  const serverPort = 15_037;

  // The per-call port moves onto the addressing, so the host never sees it as a second channel.
  await route.exec(deviceShellArgv('adb', 'shell', ['id']), { serverPort });
  route.spawn?.(['logcat'], { serverPort });
  expect(calls).toEqual([
    onPrivateServer(DEVICE.id, 'shell', 'id'),
    onPrivateServer(DEVICE.id, 'logcat'),
  ]);

  // A port typed into argv that differs from the call's is refused before adb is asked anything.
  calls.length = 0;
  await expect(route.exec(['-P', '9999', 'getprop'], { serverPort })).rejects.toMatchObject({
    details: { reason: 'managed-device-transport-mismatch' },
  });
  expect(() => route.spawn?.(['-P', '9999', 'logcat'], { serverPort })).toThrowError(
    expect.objectContaining({ details: { reason: 'managed-device-transport-mismatch' } }),
  );
  expect(calls).toEqual([]);

  // The same port spelled in argv is the same request.
  await route.exec(['-P', '15037', 'getprop'], { serverPort });
  expect(calls).toEqual([onPrivateServer(DEVICE.id, 'getprop')]);
});

function invokedServerPort(invocation: AndroidAdbInvocation): number | undefined {
  return invocation.target.server.kind === 'port' ? invocation.target.server.port : undefined;
}

test('a mark lasts its window, and marking a device drops the marks that lapsed', () => {
  vi.useFakeTimers({ toFake: ['Date'], now: 0 });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const expiries = new Map<string, number>();
  const devices = createStayedOfflineDevices(30_000, expiries);

  devices.mark('/emulator-5554');
  vi.setSystemTime(29_999);
  expect(devices.has('/emulator-5554')).toBe(true);
  vi.setSystemTime(30_000);
  expect(devices.has('/emulator-5554')).toBe(false);

  devices.mark('/emulator-5556');
  expect([...expiries.keys()]).toEqual(['/emulator-5556']);

  devices.forget('/emulator-5556');
  expect(devices.has('/emulator-5556')).toBe(false);
  expect(expiries.size).toBe(0);
});
