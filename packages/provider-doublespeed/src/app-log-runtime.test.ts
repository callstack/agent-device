import { narrowDeviceBinding } from '@agent-device/contracts/platform-runtime';
import {
  appStateUse,
  appsRuntimeUse,
  bootTargetUse,
} from '@agent-device/contracts/platform-runtime-operations';
import { expect, test, vi } from 'vitest';
import { createDoublespeedAppLogEnvelope } from './app-log-descriptor.ts';
import { createDoublespeedPlatformRuntimeOwner } from './app-log-runtime.ts';
import {
  doublespeedIosDevice as device,
  doublespeedOwnerOptions,
  doublespeedScope as scope,
} from './runtime.fixtures.ts';

const descriptor = {
  transport: 'doublespeed-log-poller',
  leaseId: 'lease-a',
  simulatorId: 'sim-a',
  appBundleId: 'com.example.app',
  outputPath: '/sessions/session/app.log',
} as const;

test('rejects a descriptor for another lease before provider reconnection', async () => {
  const reconnect = vi.fn(async () => ({ status: 'missing' as const }));
  const owner = createDoublespeedPlatformRuntimeOwner(doublespeedOwnerOptions({ reconnect }));
  const binding = await owner.bind({ device, intent: { kind: 'ordinary' }, scope });
  expect(binding.facts.device.providerMode).toBe('provider-runtime');
  const envelope = createDoublespeedAppLogEnvelope({
    sessionId: 'session',
    device,
    owner: owner.owner,
    fence: { token: 'fence', generation: 1 },
    descriptor: { ...descriptor, leaseId: 'lease-b' },
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
  const owner = createDoublespeedPlatformRuntimeOwner(
    doublespeedOwnerOptions({ openCurrent, reconnect }),
  );
  const binding = await owner.bind({ device, intent: { kind: 'ordinary' }, scope });
  const envelope = createDoublespeedAppLogEnvelope({
    sessionId: 'one',
    device,
    owner: owner.owner,
    fence: { token: 'fence', generation: 1 },
    descriptor: { ...descriptor, outputPath: '/sessions/two/app.log' },
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

test('keeps exact-owner app-log recovery available without a process-local session', async () => {
  const openCurrent = vi.fn(async () => undefined);
  const reconnect = vi.fn(async () => ({ status: 'missing' as const }));
  const owner = createDoublespeedPlatformRuntimeOwner(
    doublespeedOwnerOptions({ hasLiveSession: () => false, openCurrent, reconnect }),
  );
  const binding = await owner.bind({
    device,
    intent: { kind: 'exact-owner', owner: owner.owner, fence: { token: 'fence', generation: 1 } },
    scope,
  });
  const envelope = createDoublespeedAppLogEnvelope({
    sessionId: 'session',
    device,
    owner: owner.owner,
    fence: { token: 'fence', generation: 1 },
    descriptor,
  });

  expect(binding.operations.appLogReattach).toEqual(expect.any(Function));
  expect(binding.operations.appState).toBeUndefined();
  expect(binding.operations.listApps).toBeUndefined();
  expect(binding.facts.operations.appLogInspect).toMatchObject({
    available: false,
    reason: 'owner-capability-missing',
  });
  expect(binding.facts.operations.appLogReattach).toEqual({ available: true });
  expect(() => narrowDeviceBinding(binding, appStateUse)).toThrow(
    expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }),
  );
  expect(() => narrowDeviceBinding(binding, bootTargetUse)).toThrow(
    expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }),
  );
  expect(() => narrowDeviceBinding(binding, appsRuntimeUse)).toThrow(
    expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }),
  );
  await expect(binding.operations.appLogReattach?.({ envelope })).resolves.toEqual({
    status: 'missing',
  });
  await expect(binding.operations.appLogCleanup?.({ envelope })).resolves.toEqual({
    status: 'cleaned',
  });
  expect(openCurrent).not.toHaveBeenCalled();
  expect(reconnect).toHaveBeenCalledOnce();
});

test('a live binding serves app state and inventory through the provider session', async () => {
  const listApps = vi.fn(async () => [{ id: 'com.example.app', name: 'Example' }]);
  const getAppState = vi.fn(async () => ({ package: 'com.example.app' }));
  const owner = createDoublespeedPlatformRuntimeOwner(
    doublespeedOwnerOptions({ listApps, getAppState }),
  );
  const binding = await owner.bind({ device, intent: { kind: 'ordinary' }, scope });
  expect(binding.facts.operations.appState).toEqual({ available: true });
  await expect(binding.operations.appState?.()).resolves.toEqual({ package: 'com.example.app' });
  await expect(
    binding.operations.listApps?.({ device, filter: 'user-installed' }),
  ).resolves.toEqual([{ id: 'com.example.app', name: 'Example' }]);
});

test.each([
  {
    name: 'non-iOS Apple leaf',
    device: { ...device, appleOs: 'macos' as const, target: 'desktop' as const },
  },
  { name: 'physical Apple kind', device: { ...device, kind: 'device' as const } },
  {
    name: 'Android-shaped identity',
    device: {
      ...device,
      platform: 'android' as const,
      appleOs: undefined,
      kind: 'emulator' as const,
    },
  },
])('rejects exact binding for an impossible $name', async ({ device: invalidDevice }) => {
  const reconnect = vi.fn(async () => ({ status: 'missing' as const }));
  const owner = createDoublespeedPlatformRuntimeOwner(doublespeedOwnerOptions({ reconnect }));
  await expect(
    owner.bind({
      device: invalidDevice,
      intent: { kind: 'exact-owner', owner: owner.owner, fence: { token: 'fence', generation: 1 } },
      scope,
    }),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
  expect(reconnect).not.toHaveBeenCalled();
});
