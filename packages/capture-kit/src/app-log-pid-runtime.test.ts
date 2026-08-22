import type { DeviceInfo } from '@agent-device/kernel/device';
import { expect, test, vi } from 'vitest';
import type {
  AppLogBackgroundProcess,
  AppLogRuntimeHost,
} from '@agent-device/contracts/app-log-runtime';
import type { DurableDescriptorCodec } from '@agent-device/contracts/durable-resource-envelope';
import {
  createDurableResourceEnvelope,
  encodeDurableDescriptor,
} from './durable-resource-envelope.ts';
import { createPidScopedAppLogRuntimeOwner } from './app-log-pid-runtime.ts';

type TestDescriptor = Readonly<{
  transport: 'test-local' | 'test-provider';
  outputPath: string;
  pidPath: string;
}>;

const descriptorCodec: DurableDescriptorCodec<TestDescriptor, 'app-log'> = {
  resourceKind: 'app-log',
  version: 1,
  encode: (descriptor) => ({ ...descriptor }),
  decode: (body) =>
    typeof body.outputPath === 'string' && typeof body.pidPath === 'string'
      ? {
          status: 'decoded',
          descriptor: {
            transport: body.transport === 'test-provider' ? 'test-provider' : 'test-local',
            outputPath: body.outputPath,
            pidPath: body.pidPath,
          },
        }
      : { status: 'invalid', message: 'invalid test descriptor' },
};

const device: DeviceInfo = {
  platform: 'android',
  id: 'device-1',
  name: 'Device',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

test('PID-scoped runtime owner derives canonical artifacts and publishes one complete binding', async () => {
  const fixture = hostFixture();
  const owner = createPidScopedAppLogRuntimeOwner(fixture.host, {
    family: 'android',
    backend: 'android',
    codec: descriptorCodec,
    label: 'Android',
    startUnavailableHint: 'No app-log transport.',
    cleanupFailureMessage: 'cleanup failed',
    doctor: async () => ({ backend: 'android', checks: {}, notes: [] }),
    process: async ({ device: selected }) => ({
      resolvePid: async () => '123',
      command: (pid) => ({
        kind: 'android-adb',
        serial: selected.id,
        args: ['logcat', '--pid', pid],
      }),
    }),
    descriptor: ({ artifacts, transport }) => ({
      transport: transport.mode === 'local' ? 'test-local' : 'test-provider',
      ...artifacts,
    }),
    envelope: ({ input, device: selected, owner: selectedOwner, descriptor }) =>
      createDurableResourceEnvelope({
        resourceKind: 'app-log',
        sessionId: input.sessionId,
        device: {
          id: selected.id,
          family: 'android',
          kind: selected.kind,
          target: selected.target,
        },
        owner: selectedOwner,
        fence: input.fence,
        lifecycle: 'open',
        descriptor: encodeDurableDescriptor(descriptorCodec, descriptor),
      }),
  });
  const binding = await owner.bind({
    device,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });

  const started = await binding.operations.appLogStart?.({
    sessionId: 'session-1',
    appBundleId: 'com.example.app',
    outputPath: '/sessions/session-1/app.log',
    fence: { token: 'fence', generation: 1 },
  });

  expect(binding.facts.device.providerMode).toBe('local');
  expect(started?.envelope.descriptor.body).toEqual({
    transport: 'test-local',
    outputPath: '/sessions/session-1/app.log',
    pidPath: '/sessions/session-1/app-log.pid',
  });
  expect(fixture.commands).toEqual([
    { kind: 'android-adb', serial: 'device-1', args: ['logcat', '--pid', '123'] },
  ]);
  await started?.pendingHandle.transfer().finish();
});

function hostFixture() {
  const commands: unknown[] = [];
  let resolveWait: (() => void) | undefined;
  const wait = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
    resolveWait = () => resolve({ stdout: '', stderr: '', exitCode: 0 });
  });
  const process: AppLogBackgroundProcess = {
    wait,
    terminate: async () => resolveWait?.(),
    [Symbol.asyncDispose]: async () => {},
  };
  const start: AppLogRuntimeHost['processes']['start'] = vi.fn(async ({ command }) => {
    commands.push(command);
    return process;
  });
  const host: AppLogRuntimeHost = {
    appleTools: {
      isXcrunAvailable: async () => false,
      run: async () => {
        throw new Error('unused');
      },
    },
    toolchains: { prepare: async () => {} },
    artifacts: {
      resolveSession: (sessionId) => ({
        outputPath: `/sessions/${sessionId}/app.log`,
        pidPath: `/sessions/${sessionId}/app-log.pid`,
      }),
    },
    commands: {
      which: async () => undefined,
      run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    },
    outputs: {
      openAppend: async () => ({
        write: async () => {},
        [Symbol.asyncDispose]: async () => {},
      }),
      readTail: async () => '',
    },
    processTransports: { resolve: async () => ({ mode: 'local', start }) },
    processes: {
      start,
      readMarker: async () => ({ status: 'missing' }),
      clearMarker: async () => {},
      inspect: async () => 'missing',
      terminate: async () => 'already-missing',
    },
    clock: { now: () => 10, sleep: waitForMonitorWake },
  };
  return { host, commands };
}

async function waitForMonitorWake(_milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });
}
