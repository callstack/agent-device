import type {
  AppLogBackgroundProcess,
  AppLogRuntimeHost,
  PlatformRequestScope,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { expect, test, vi } from 'vitest';
import { createHarmonyAppLogEnvelope } from './descriptor.ts';
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
  await vi.waitFor(() => {
    expect(fixture.backgroundCommands).toEqual([
      ['hdc', '-t', 'harmony-1', 'shell', 'hilog', '-P', '456'],
    ]);
  });
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

function hostFixture() {
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
    backgroundCommands.push([command.executable, ...command.args]);
    return process;
  };
  const host: AppLogRuntimeHost = {
    artifacts: {
      resolveSession: () => ({ outputPath: '/tmp/app.log', pidPath: '/tmp/app-log.pid' }),
    },
    commands: {
      which: async () => 'hdc',
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
    clock: { now: () => 10, sleep: async () => {} },
  };
  return {
    host,
    backgroundCommands,
    markerReads: () => markerReads,
    outputOpens: () => outputOpens,
  };
}
