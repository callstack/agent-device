import type { AppLogRuntimeHost, PlatformRequestScope } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { expect, test, vi } from 'vitest';
import { createLimrunAppLogEnvelope } from './app-log-descriptor.ts';
import { createLimrunAppLogRuntimeOwner } from './app-log-runtime.ts';

const device: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'limrun:ios:lease-a',
  name: 'Limrun iOS',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

const scope: PlatformRequestScope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => {} },
  progress: { report: () => {} },
};

test('rejects a cross-platform durable descriptor before provider reconnection', async () => {
  const reconnect = vi.fn(async () => ({ status: 'missing' as const }));
  const owner = createLimrunAppLogRuntimeOwner({
    host: unusedHost(),
    runtimeInstance: 'default',
    ownsDevice: () => true,
    openCurrent: async () => undefined,
    reconnect,
  });
  const binding = await owner.bind({
    device,
    intent: { kind: 'ordinary' },
    scope,
  });
  expect(binding.facts.device.providerMode).toBe('provider-runtime');
  const envelope = createLimrunAppLogEnvelope({
    sessionId: 'session',
    device,
    owner: owner.owner,
    fence: { token: 'fence', generation: 1 },
    descriptor: {
      transport: 'limrun-log-poller',
      platform: 'android',
      leaseId: 'lease-a',
      instanceId: 'instance-a',
      appBundleId: 'com.example.app',
      outputPath: '/sessions/one/app.log',
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
  expect(reconnect).not.toHaveBeenCalled();
});

test('rejects cross-session paths before reconnecting or opening a provider reader', async () => {
  const reconnect = vi.fn(async () => ({ status: 'missing' as const }));
  const openCurrent = vi.fn(async () => undefined);
  const owner = createLimrunAppLogRuntimeOwner({
    host: unusedHost(),
    runtimeInstance: 'default',
    ownsDevice: () => true,
    openCurrent,
    reconnect,
  });
  const binding = await owner.bind({ device, intent: { kind: 'ordinary' }, scope });
  const envelope = createLimrunAppLogEnvelope({
    sessionId: 'one',
    device,
    owner: owner.owner,
    fence: { token: 'fence', generation: 1 },
    descriptor: {
      transport: 'limrun-log-poller',
      platform: 'ios',
      leaseId: 'lease-a',
      instanceId: 'instance-a',
      appBundleId: 'com.example.app',
      outputPath: '/sessions/two/app.log',
    },
  });

  await expect(binding.operations.appLogReattach?.({ envelope })).resolves.toMatchObject({
    status: 'unreattachable',
    reason: 'descriptor-invalid',
  });
  await expect(
    binding.operations.appLogStart?.({
      sessionId: 'one',
      appBundleId: 'com.example.app',
      outputPath: '/sessions/two/app.log',
      fence: { token: 'fence', generation: 1 },
    }),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  expect(reconnect).not.toHaveBeenCalled();
  expect(openCurrent).not.toHaveBeenCalled();
});

test.each([
  {
    name: 'HarmonyOS device carrying an Android-shaped Limrun id',
    device: {
      ...device,
      platform: 'harmonyos' as const,
      appleOs: undefined,
      id: 'limrun:android:lease-a',
      kind: 'device' as const,
    },
  },
  {
    name: 'non-iOS Apple leaf',
    device: { ...device, appleOs: 'macos' as const, target: 'desktop' as const },
  },
  {
    name: 'physical Apple kind',
    device: { ...device, kind: 'device' as const },
  },
])('rejects exact binding for an impossible Limrun $name', async ({ device: invalidDevice }) => {
  const reconnect = vi.fn(async () => ({ status: 'missing' as const }));
  const owner = createLimrunAppLogRuntimeOwner({
    host: unusedHost(),
    runtimeInstance: 'default',
    ownsDevice: () => true,
    openCurrent: async () => undefined,
    reconnect,
  });

  await expect(
    owner.bind({
      device: invalidDevice,
      intent: {
        kind: 'exact-owner',
        owner: owner.owner,
        fence: { token: 'fence', generation: 1 },
      },
      scope,
    }),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
  expect(reconnect).not.toHaveBeenCalled();
});

function unusedHost(): AppLogRuntimeHost {
  return {
    appleTools: {
      isXcrunAvailable: async () => false,
      run: async () => {
        throw new Error('unused');
      },
    },
    toolchains: { prepare: async () => undefined },
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
      readTail: async () => '',
      openAppend: async () => {
        throw new Error('unused');
      },
    },
    processTransports: {
      resolve: async () => ({ mode: 'local' }),
    },
    processes: {
      start: async () => {
        throw new Error('unused');
      },
      readMarker: async () => ({ status: 'missing' }),
      clearMarker: async () => {},
      inspect: async () => 'missing',
      terminate: async () => 'already-missing',
    },
    clock: { now: () => 1, sleep: async () => {} },
  };
}
