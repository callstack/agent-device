import type {
  AppLogBackgroundProcess,
  AppLogOutputSink,
  AppLogRuntimeHost,
  PlatformRequestScope,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { describe, expect, test } from 'vitest';
import { androidAppLogDescriptorCodec, createAndroidAppLogEnvelope } from './descriptor.ts';
import { createAndroidAppLogRuntime } from './runtime.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

const scope: PlatformRequestScope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => {} },
  progress: { report: () => {} },
};

describe('Android app-log runtime', () => {
  test('decodes only marker-backed local and transport-composed descriptors', () => {
    for (const transport of [
      'android-logcat-local',
      'android-logcat-transport-composed',
    ] as const) {
      expect(
        androidAppLogDescriptorCodec.decode({
          transport,
          outputPath: '/tmp/app.log',
          pidPath: '/tmp/app-log.pid',
        }),
      ).toMatchObject({ status: 'decoded', descriptor: { transport } });
    }
    expect(
      androidAppLogDescriptorCodec.decode({
        transport: 'android-logcat-transport-composed',
        outputPath: '/tmp/app.log',
      }),
    ).toMatchObject({ status: 'invalid' });
    expect(
      androidAppLogDescriptorCodec.decode({
        transport: 'android-logcat',
        outputPath: '/tmp/app.log',
        pidPath: '/tmp/app-log.pid',
      }),
    ).toMatchObject({ status: 'invalid' });
  });

  test('binds complete local facts and preserves logcat recovery command parity', async () => {
    const fixture = hostFixture();
    const owner = createAndroidAppLogRuntime(fixture.host);
    const binding = await owner.bind({ device, intent: { kind: 'ordinary' }, scope });

    expect(binding.facts.operations.appLogStart).toEqual({ available: true });
    const started = await binding.operations.appLogStart?.({
      sessionId: 'session-1',
      appBundleId: 'com.example.app',
      outputPath: '/tmp/app.log',
      pidPath: '/tmp/app-log.pid',
      fence: { token: 'fence', generation: 1 },
    });
    expect(started?.envelope.descriptor.body).toEqual({
      transport: 'android-logcat-local',
      outputPath: '/tmp/app.log',
      pidPath: '/tmp/app-log.pid',
    });
    expect(fixture.commands).toEqual([
      ['adb', '-s', 'emulator-5554', 'shell', 'pidof', 'com.example.app'],
    ]);
    expect(fixture.backgroundCommands).toEqual([
      ['adb', '-s', 'emulator-5554', 'logcat', '-v', 'time', '--pid', '123'],
    ]);

    const handle = started?.pendingHandle.transfer();
    expect(handle?.inspect()).toMatchObject({ backend: 'android', state: 'active' });
    expect(await handle?.finish()).toMatchObject({
      status: 'completed',
      result: { backend: 'android', outputPath: '/tmp/app.log' },
    });
    expect(fixture.terminated()).toBe(true);
    expect(fixture.outputDisposed()).toBe(true);
  });

  test('keeps unsafe package names out of adb arguments', async () => {
    const fixture = hostFixture();
    const binding = await createAndroidAppLogRuntime(fixture.host).bind({
      device,
      intent: { kind: 'ordinary' },
      scope,
    });
    await expect(
      binding.operations.appLogStart?.({
        sessionId: 'session-1',
        appBundleId: 'com.example; reboot',
        outputPath: '/tmp/app.log',
        fence: { token: 'fence', generation: 1 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(fixture.commands).toEqual([]);
  });

  test('preserves the exact request cancellation reason during doctor probes', async () => {
    const controller = new AbortController();
    const reason = new Error('request cancelled');
    const fixture = hostFixture({
      commandRun: async () => {
        controller.abort(reason);
        throw reason;
      },
    });
    const binding = await createAndroidAppLogRuntime(fixture.host).bind({
      device,
      intent: { kind: 'ordinary' },
      scope: { ...scope, signal: controller.signal },
    });
    await expect(
      binding.operations.appLogDoctor?.({ appBundleId: 'com.example.app' }),
    ).rejects.toBe(reason);
  });

  test('rejects cross-session start and recovery paths before host authority is used', async () => {
    const fixture = hostFixture();
    const runtimeOwner = createAndroidAppLogRuntime(fixture.host);
    const binding = await runtimeOwner.bind({ device, intent: { kind: 'ordinary' }, scope });
    const envelope = createAndroidAppLogEnvelope({
      sessionId: 'session-1',
      device,
      owner: runtimeOwner.owner,
      fence: { token: 'fence', generation: 1 },
      descriptor: {
        transport: 'android-logcat-local',
        outputPath: '/tmp/app.log',
        pidPath: '/tmp/other/app-log.pid',
      },
    });

    await expect(binding.operations.appLogReattach?.({ envelope })).resolves.toMatchObject({
      status: 'unreattachable',
      reason: 'descriptor-invalid',
    });
    await expect(binding.operations.appLogCleanup?.({ envelope })).resolves.toMatchObject({
      status: 'cleanup-pending',
      reason: 'ownership-fence-lost',
    });
    await expect(
      binding.operations.appLogStart?.({
        sessionId: 'session-1',
        appBundleId: 'com.example.app',
        outputPath: '/tmp/other/app.log',
        fence: { token: 'fence', generation: 1 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(fixture.markerReads()).toBe(0);
    expect(fixture.outputOpens()).toBe(0);
  });

  test('classifies a captured narrow provider transport while preserving marker authority', async () => {
    const fixture = hostFixture({ processTransportMode: 'transport-composed' });
    const binding = await createAndroidAppLogRuntime(fixture.host).bind({
      device,
      intent: { kind: 'ordinary' },
      scope,
    });

    expect(binding.facts.device.providerMode).toBe('transport-composed');
    expect(binding.facts.operations.appLogStart).toEqual({ available: true });
    const started = await binding.operations.appLogStart?.({
      sessionId: 'session-1',
      appBundleId: 'com.example.app',
      outputPath: '/tmp/app.log',
      pidPath: '/tmp/app-log.pid',
      fence: { token: 'fence', generation: 1 },
    });
    expect(started?.envelope.descriptor.body).toEqual({
      transport: 'android-logcat-transport-composed',
      outputPath: '/tmp/app.log',
      pidPath: '/tmp/app-log.pid',
    });
    expect(fixture.markerPaths).toEqual(['/tmp/app-log.pid']);
    await started?.pendingHandle.transfer().finish();
  });

  test('fails closed when a narrow provider transport cannot spawn logcat', async () => {
    const fixture = hostFixture({
      processTransportMode: 'transport-composed',
      processStartAvailable: false,
    });
    const binding = await createAndroidAppLogRuntime(fixture.host).bind({
      device,
      intent: { kind: 'ordinary' },
      scope,
    });

    expect(binding.facts.operations.appLogStart).toMatchObject({
      available: false,
      reason: 'owner-capability-missing',
    });
    expect(binding.operations.appLogStart).toBeUndefined();
  });

  test('rejects before envelope adoption when initial managed process publication fails', async () => {
    const failure = new Error('marker publication failed');
    const fixture = hostFixture({ processStartError: failure });
    const binding = await createAndroidAppLogRuntime(fixture.host).bind({
      device,
      intent: { kind: 'ordinary' },
      scope,
    });

    await expect(
      binding.operations.appLogStart?.({
        sessionId: 'session-1',
        appBundleId: 'com.example.app',
        outputPath: '/tmp/app.log',
        pidPath: '/tmp/app-log.pid',
        fence: { token: 'fence', generation: 1 },
      }),
    ).rejects.toBe(failure);
    expect(fixture.outputDisposed()).toBe(true);
  });
});

function hostFixture(
  options: {
    commandRun?: AppLogRuntimeHost['commands']['run'];
    processTransportMode?: 'local' | 'transport-composed';
    processStartAvailable?: boolean;
    processStartError?: Error;
  } = {},
) {
  const commands: string[][] = [];
  const backgroundCommands: string[][] = [];
  let terminated = false;
  let outputDisposed = false;
  let outputOpens = 0;
  let markerReads = 0;
  const markerPaths: Array<string | undefined> = [];
  let resolveWait:
    | ((result: { stdout: string; stderr: string; exitCode: number }) => void)
    | undefined;
  const wait = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
    resolveWait = resolve;
  });
  const output: AppLogOutputSink = {
    write: async () => {},
    [Symbol.asyncDispose]: async () => {
      outputDisposed = true;
    },
  };
  const process: AppLogBackgroundProcess = {
    marker: { pid: 42, startTime: 'started', command: 'adb logcat --pid 123' },
    wait,
    terminate: async () => {
      terminated = true;
      resolveWait?.({ stdout: '', stderr: '', exitCode: 0 });
    },
    [Symbol.asyncDispose]: async () => {},
  };
  const startProcess: AppLogRuntimeHost['processes']['start'] = async ({ command, markerPath }) => {
    if (command.kind !== 'android-adb') throw new Error('Expected a typed Android adb command');
    backgroundCommands.push(['adb', '-s', command.serial, ...command.args]);
    markerPaths.push(markerPath);
    if (options.processStartError) throw options.processStartError;
    return process;
  };
  const host: AppLogRuntimeHost = {
    appleTools: {
      isXcrunAvailable: async () => false,
      run: async () => {
        throw new Error('unused');
      },
    },
    toolchains: { prepare: async () => undefined },
    artifacts: {
      resolveSession: () => ({ outputPath: '/tmp/app.log', pidPath: '/tmp/app-log.pid' }),
    },
    commands: {
      which: async () => 'adb',
      run: async (request, signal) => {
        if (options.commandRun) return await options.commandRun(request, signal);
        const { executable, args } = request;
        commands.push([executable, ...args]);
        return { stdout: '123\n', stderr: '', exitCode: 0 };
      },
    },
    outputs: {
      openAppend: async () => {
        outputOpens += 1;
        return output;
      },
      readTail: async () => '',
    },
    processTransports: {
      resolve: async () => ({
        mode: options.processTransportMode ?? 'local',
        ...(options.processStartAvailable === false ? {} : { start: startProcess }),
      }),
    },
    processes: {
      start: startProcess,
      readMarker: async () => {
        markerReads += 1;
        return { status: 'missing' };
      },
      clearMarker: async () => {},
      inspect: async () => 'missing',
      terminate: async () => 'already-missing',
    },
    clock: { now: () => 100, sleep: waitForMonitorWake },
  };
  return {
    host,
    commands,
    backgroundCommands,
    terminated: () => terminated,
    outputDisposed: () => outputDisposed,
    outputOpens: () => outputOpens,
    markerReads: () => markerReads,
    markerPaths,
  };
}

async function waitForMonitorWake(_milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });
}
