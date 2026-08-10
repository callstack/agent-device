import type {
  AppLogBackgroundProcess,
  AppLogRuntimeHost,
  PlatformRequestScope,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { expect, test, vi } from 'vitest';
import { createHarmonyAppLogEnvelope, harmonyAppLogDescriptorCodec } from './descriptor.ts';
import { createHarmonyAppLogRuntime } from './runtime.ts';

const device: DeviceInfo = {
  platform: 'harmonyos',
  id: 'harmony-1',
  name: 'Harmony',
  kind: 'device',
  target: 'mobile',
  booted: true,
};
const scope: PlatformRequestScope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => {} },
  progress: { report: () => {} },
};

test('rejects durable HarmonyOS descriptors without the canonical process marker', () => {
  expect(
    harmonyAppLogDescriptorCodec.decode({
      transport: 'harmony-hilog',
      outputPath: '/tmp/app.log',
    }),
  ).toMatchObject({ status: 'invalid' });
});

test('starts HarmonyOS hilog with the resolved application pid', async () => {
  const fixture = hostFixture();
  const binding = await createHarmonyAppLogRuntime(fixture.host).bind({
    device,
    intent: { kind: 'ordinary' },
    scope,
  });
  const started = await binding.operations.appLogStart?.({
    sessionId: 'session',
    appBundleId: 'com.example.harmony',
    outputPath: '/tmp/app.log',
    fence: { token: 'fence', generation: 1 },
  });
  expect(fixture.backgroundCommands).toEqual([
    ['hdc', '-t', 'harmony-1', 'shell', 'hilog', '-P', '456'],
  ]);
  expect(await started?.pendingHandle.transfer().finish()).toMatchObject({
    status: 'completed',
    result: { backend: 'harmonyos' },
  });
});

test('rejects cross-session start and recovery paths before host authority is used', async () => {
  const fixture = hostFixture();
  const runtimeOwner = createHarmonyAppLogRuntime(fixture.host);
  const binding = await runtimeOwner.bind({ device, intent: { kind: 'ordinary' }, scope });
  const envelope = createHarmonyAppLogEnvelope({
    sessionId: 'session',
    device,
    owner: runtimeOwner.owner,
    fence: { token: 'fence', generation: 1 },
    descriptor: {
      transport: 'harmony-hilog',
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
      sessionId: 'session',
      appBundleId: 'com.example.harmony',
      outputPath: '/tmp/other/app.log',
      fence: { token: 'fence', generation: 1 },
    }),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  expect(fixture.markerReads()).toBe(0);
  expect(fixture.outputOpens()).toBe(0);
});

test('rejects a missing HDC tool before opening output or starting a process', async () => {
  const fixture = hostFixture({ whichHdc: async () => undefined });
  const binding = await createHarmonyAppLogRuntime(fixture.host).bind({
    device,
    intent: { kind: 'ordinary' },
    scope,
  });

  await expect(
    binding.operations.appLogStart?.({
      sessionId: 'session',
      appBundleId: 'com.example.harmony',
      outputPath: '/tmp/app.log',
      fence: { token: 'fence', generation: 1 },
    }),
  ).rejects.toMatchObject({
    code: 'TOOL_MISSING',
    message: 'hdc not found in PATH',
    details: {
      hint: 'Install HarmonyOS Command Line Tools, then add its sdk/default/openharmony/toolchains directory to PATH.',
    },
  });
  expect(fixture.outputOpens()).toBe(0);
  expect(fixture.backgroundCommands).toEqual([]);
});

test('provider-selected HarmonyOS logs prepare configured HDC without local inventory discovery', async () => {
  const events: string[] = [];
  const prepare = vi.fn(async () => {
    events.push('prepare');
  });
  const whichHdc = vi.fn(async () => {
    expect(events).toEqual(['prepare']);
    events.push('which');
    return '/configured/toolchains/hdc';
  });
  const fixture = hostFixture({ prepare, whichHdc });
  const binding = await createHarmonyAppLogRuntime(fixture.host).bind({
    device,
    intent: { kind: 'ordinary' },
    scope,
  });

  const started = await binding.operations.appLogStart?.({
    sessionId: 'session',
    appBundleId: 'com.example.harmony',
    outputPath: '/tmp/app.log',
    fence: { token: 'fence', generation: 1 },
  });

  expect(prepare).toHaveBeenCalledWith('harmonyos');
  expect(whichHdc).toHaveBeenCalledWith('hdc');
  expect(events).toEqual(['prepare', 'which']);
  expect(fixture.backgroundCommands).toEqual([
    ['/configured/toolchains/hdc', '-t', 'harmony-1', 'shell', 'hilog', '-P', '456'],
  ]);
  await started?.pendingHandle.transfer().finish();
});

test('HarmonyOS log preflight preserves cancellation when toolchain preparation rejects differently', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled');
  const transportError = new Error('toolchain preparation failed');
  const whichHdc = vi.fn(async () => 'hdc');
  const fixture = hostFixture({
    prepare: async () => {
      controller.abort(reason);
      throw transportError;
    },
    whichHdc,
  });
  const binding = await createHarmonyAppLogRuntime(fixture.host).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: { ...scope, signal: controller.signal },
  });

  await expect(
    binding.operations.appLogStart?.({
      sessionId: 'session',
      appBundleId: 'com.example.harmony',
      outputPath: '/tmp/app.log',
      fence: { token: 'fence', generation: 1 },
    }),
  ).rejects.toBe(reason);
  expect(whichHdc).not.toHaveBeenCalled();
  expect(fixture.outputOpens()).toBe(0);
  expect(fixture.backgroundCommands).toEqual([]);
});

test('HarmonyOS log preflight preserves cancellation when HDC lookup rejects differently', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled');
  const transportError = new Error('tool lookup failed');
  const fixture = hostFixture({
    whichHdc: async () => {
      controller.abort(reason);
      throw transportError;
    },
  });
  const binding = await createHarmonyAppLogRuntime(fixture.host).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: { ...scope, signal: controller.signal },
  });

  await expect(
    binding.operations.appLogStart?.({
      sessionId: 'session',
      appBundleId: 'com.example.harmony',
      outputPath: '/tmp/app.log',
      fence: { token: 'fence', generation: 1 },
    }),
  ).rejects.toBe(reason);
  expect(fixture.outputOpens()).toBe(0);
  expect(fixture.backgroundCommands).toEqual([]);
});

function hostFixture(
  options: {
    prepare?: AppLogRuntimeHost['toolchains']['prepare'];
    whichHdc?: AppLogRuntimeHost['commands']['which'];
  } = {},
) {
  const backgroundCommands: string[][] = [];
  let outputOpens = 0;
  let markerReads = 0;
  let resolveWait: (() => void) | undefined;
  const wait = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
    resolveWait = () => resolve({ stdout: '', stderr: '', exitCode: 0 });
  });
  const process: AppLogBackgroundProcess = {
    wait,
    terminate: async () => resolveWait?.(),
    [Symbol.asyncDispose]: async () => {},
  };
  const startProcess: AppLogRuntimeHost['processes']['start'] = async ({ command }) => {
    if (command.kind !== 'host') throw new Error('Expected a HarmonyOS host command');
    backgroundCommands.push([command.request.executable, ...command.request.args]);
    return process;
  };
  const host: AppLogRuntimeHost = {
    appleTools: {
      isXcrunAvailable: async () => false,
      run: async () => {
        throw new Error('unused');
      },
    },
    toolchains: { prepare: options.prepare ?? (async () => undefined) },
    artifacts: {
      resolveSession: () => ({ outputPath: '/tmp/app.log', pidPath: '/tmp/app-log.pid' }),
    },
    commands: {
      which: options.whichHdc ?? (async () => 'hdc'),
      run: async () => ({ stdout: '456\n', stderr: '', exitCode: 0 }),
    },
    outputs: {
      readTail: async () => '',
      openAppend: async () => {
        outputOpens += 1;
        return { write: async () => {}, [Symbol.asyncDispose]: async () => {} };
      },
    },
    processTransports: {
      resolve: async () => ({ mode: 'local', start: startProcess }),
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
    clock: { now: () => 10, sleep: waitForMonitorWake },
  };
  return {
    host,
    backgroundCommands,
    markerReads: () => markerReads,
    outputOpens: () => outputOpens,
  };
}

async function waitForMonitorWake(_milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });
}
