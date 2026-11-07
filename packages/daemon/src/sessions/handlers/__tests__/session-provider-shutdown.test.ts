import { withTestDeviceInventory } from '@agent-device/device-selection/inventory-gateways-fixtures';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  narrowDeviceBinding,
  providerRuntimeOwner,
  localRuntimeOwner,
  type DeviceBinding,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { AppError } from '@agent-device/kernel/errors';
import {
  bindTestCommandHost,
  createTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { mockResolveTargetDevice } from '../../../__tests__/support/handlers/session-test-harness.ts';
import { handleSessionCommands } from '../../../__tests__/support/handlers/session-command-harness.ts';
import { lifecycleRuntimeFacts } from '../../../__tests__/support/application-lifecycle-runtime-harness.ts';
import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { fakeCreateCommandSurface } from '../../../__tests__/support/command-surface-fake.ts';
import { LeaseRegistry } from '../../../resources/lease-registry.ts';
import { SessionStore } from '../../../core/session-store.ts';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import { resolveSessionScope } from '../../session-routing.ts';
import { handleShutdownCommand } from '../session-shutdown.ts';

bindTestCommandHost();

function scenario(platform: 'ios' | 'android', activeSession = false, sessionAddress = 'test') {
  const host = createTestHostEnvironment();
  const root = mkdtempForTestSync('agent-device-provider-shutdown-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'), host);
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({
    leaseId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    tenantId: 'tenant',
    runId: 'run',
    leaseProvider: 'limrun',
    leaseBackend: platform === 'ios' ? 'ios-instance' : 'android-instance',
    retainOnClose: true,
  });
  const device: DeviceInfo = {
    platform: platform === 'ios' ? 'apple' : 'android',
    ...(platform === 'ios' ? { appleOs: 'ios' as const } : {}),
    id: `limrun:${platform}:${lease.leaseId}`,
    name: 'Provider device',
    kind: platform === 'ios' ? 'simulator' : 'emulator',
    booted: true,
  };
  const events: string[] = [];
  const release = vi.fn(async () => {
    expect(leaseRegistry.listActiveLeases()).toContainEqual(lease);
    events.push('release');
    return { limrunInstanceId: 'instance' };
  });
  const base = lifecycleRuntimeFacts(device);
  const facts = {
    ...base,
    device: { ...base.device, providerMode: 'provider-runtime' as const },
    operations: { ...base.operations, shutdownTarget: { available: true as const } },
  };
  const binding: DeviceBinding<PlatformRuntimeOperations> = {
    device,
    owner: providerRuntimeOwner('limrun', 'runtime'),
    facts,
    operations: {
      closeApplication: async () => {
        events.push('close');
      },
      finalizeApplicationClose: async () => {
        events.push('finalize');
        return {};
      },
      shutdownTarget: async ({ releaseLease }) => await releaseLease(lease.leaseId),
    },
    [Symbol.asyncDispose]: async () => {},
  };
  const req: DaemonRequest = {
    token: 't',
    command: activeSession ? 'close' : 'shutdown',
    session: sessionAddress,
    positionals: [],
    flags: { platform, shutdown: activeSession },
    meta: {
      tenantId: lease.tenantId,
      runId: lease.runId,
      leaseId: lease.leaseId,
      leaseProvider: 'limrun',
      leaseBackend: lease.backend,
    },
    internal: { endedLeases: [] },
  };
  if (activeSession) {
    sessionStore.publish(sessionAddress, {
      name: 'test',
      sessionScope: resolveSessionScope(req),
      device,
      appName: 'Example',
      appBundleId: 'com.example.app',
      createdAt: Date.now(),
      actions: [],
      lease: {
        tenantId: lease.tenantId,
        runId: lease.runId,
        leaseId: lease.leaseId,
        leaseProvider: 'limrun',
        leaseBackend: lease.backend,
      },
    });
  }
  const bindDevice: NonNullable<Parameters<typeof handleShutdownCommand>[0]['bindDevice']> = async (
    _device,
    use,
  ) => narrowDeviceBinding(binding, use);
  const params = {
    host,
    req,
    sessionName: sessionAddress,
    sessionStore,
    leaseRegistry,
    leaseLifecycleProvider: { release },
    platformServices: daemonPlatformServicesFixture(),
    inspectFacts: async () => facts,
    bindDevice,
  };
  const run = async () => {
    mockResolveTargetDevice.mockResolvedValue(device);
    return activeSession
      ? await handleSessionCommands({
          ...params,
          logPath: path.join(root, 'daemon.log'),
          createCommandSurface: fakeCreateCommandSurface,
          invoke: async () => ({ ok: true, data: {} }),
        })
      : await handleShutdownCommand(params);
  };
  return { run, req, release, leaseRegistry, sessionStore, events, binding };
}

for (const platform of ['ios', 'android'] as const) {
  test(`${platform} shutdown releases a retained provider lease and reports it ended`, async () => {
    const world = scenario(platform);
    const response = await world.run();
    expect(response).toMatchObject({
      ok: true,
      data: { shutdown: { success: true }, provider: { limrunInstanceId: 'instance' } },
    });
    expect(world.release).toHaveBeenCalledOnce();
    expect(world.leaseRegistry.listActiveLeases()).toEqual([]);
    expect(world.req.internal?.endedLeases).toEqual([
      { leaseId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', outcome: 'released' },
    ]);
  });

  test(`${platform} close --shutdown finalizes before releasing a retained lease exactly once`, async () => {
    const world = scenario(platform, true);
    expect(await world.run()).toMatchObject({ ok: true, data: { shutdown: { success: true } } });
    expect(world.events).toEqual(['finalize', 'release']);
    expect(world.release).toHaveBeenCalledOnce();
    expect(world.sessionStore.get('test')).toBeUndefined();
    expect(world.leaseRegistry.listActiveLeases()).toEqual([]);
  });
}

test('failed provider deletion keeps the session and lease for close --shutdown retry', async () => {
  const world = scenario('android', true);
  world.release.mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'Delete failed'));
  expect(await world.run()).toMatchObject({ ok: false, error: { retriable: true } });
  expect(world.sessionStore.get('test')).toBeDefined();
  expect(world.leaseRegistry.listActiveLeases()).toHaveLength(1);
  expect(world.req.internal?.endedLeases).toEqual([]);
  expect(await world.run()).toMatchObject({ ok: true, data: { shutdown: { success: true } } });
  expect(world.sessionStore.get('test')).toBeUndefined();
  expect(world.leaseRegistry.listActiveLeases()).toEqual([]);
});

test('standalone shutdown identifies the scoped session using its target', async () => {
  const sessionAddress = 'cwd:abc123:test';
  const world = scenario('android', true, sessionAddress);
  world.req.session = 'default';
  world.req.meta = { ...world.req.meta, cwd: '/workspace/current' };
  world.sessionStore.get(sessionAddress)!.sessionScope = resolveSessionScope(world.req);
  world.req.command = 'shutdown';
  mockResolveTargetDevice.mockResolvedValue(world.binding.device);
  const response = await handleShutdownCommand({
    host: createTestHostEnvironment(),
    req: world.req,
    sessionName: 'other',
    sessionStore: world.sessionStore,
    platformServices: daemonPlatformServicesFixture(),
    inspectFacts: async () => world.binding.facts,
  });
  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'DEVICE_IN_USE',
      details: {
        session: sessionAddress,
        hint: `Run agent-device close --shutdown --session ${sessionAddress}`,
      },
    },
  });
  expect(world.release).not.toHaveBeenCalled();
});

test('ordinary close preserves a retained provider lease', async () => {
  const world = scenario('ios', true);
  world.req.flags = { platform: 'ios' };
  expect(await world.run()).toMatchObject({ ok: true });
  expect(world.release).not.toHaveBeenCalled();
  expect(world.leaseRegistry.listActiveLeases()).toHaveLength(1);
});

test('a provider cannot release a target outside the request lease', async () => {
  const world = scenario('android');
  world.req.meta = { ...world.req.meta, leaseId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
  await expect(world.run()).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
    details: { reason: 'TARGET_SHUTDOWN_LEASE_MISMATCH' },
  });
  expect(world.release).not.toHaveBeenCalled();
  expect(world.leaseRegistry.listActiveLeases()).toHaveLength(1);
});

test('failed shutdown preparation keeps the session and retained lease for retry', async () => {
  const world = scenario('android', true);
  vi.spyOn(world.binding.operations, 'finalizeApplicationClose').mockRejectedValueOnce(
    new Error('IME restore failed'),
  );
  expect(await world.run()).toMatchObject({
    ok: false,
    error: {
      retriable: true,
      message: expect.stringContaining('IME restore failed'),
      details: { reason: 'session_cleanup_incomplete', failedSteps: ['application_lifecycle'] },
    },
  });
  expect(world.release).not.toHaveBeenCalled();
  expect(world.sessionStore.get('test')).toBeDefined();
  expect(world.leaseRegistry.listActiveLeases()).toHaveLength(1);
  expect(await world.run()).toMatchObject({ ok: true, data: { shutdown: { success: true } } });
});

for (const platform of ['ios', 'android'] as const) {
  test(`${platform} unallocated provider shutdown cannot select a booted local device`, async () => {
    const world = scenario(platform);
    world.req.meta = { ...world.req.meta, leaseId: undefined };
    const localDevice: DeviceInfo = { ...world.binding.device, id: 'local-device', booted: true };
    mockResolveTargetDevice.mockClear();
    const actual = await vi.importActual<
      typeof import('@agent-device/device-selection/dispatch-resolve')
    >('@agent-device/device-selection/dispatch-resolve');
    mockResolveTargetDevice.mockImplementation(actual.resolveTargetDevice);
    const local = vi.fn(async () => [localDevice]);
    const shutdownTarget = vi.fn(async () => ({
      success: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));
    const bound = vi.fn();
    const localBinding: DeviceBinding<PlatformRuntimeOperations> = {
      ...world.binding,
      device: localDevice,
      owner: localRuntimeOwner(localDevice.platform),
      operations: { shutdownTarget },
    };
    const bindDevice: NonNullable<
      Parameters<typeof handleShutdownCommand>[0]['bindDevice']
    > = async (_device, use) => {
      bound();
      return narrowDeviceBinding(localBinding, use);
    };
    await expect(
      withTestDeviceInventory({ local }, () =>
        handleShutdownCommand({
          host: createTestHostEnvironment(),
          req: world.req,
          sessionName: 'test',
          sessionStore: world.sessionStore,
          platformServices: daemonPlatformServicesFixture(),
          inspectFacts: async () => world.binding.facts,
          bindDevice,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'DEVICE_NOT_FOUND',
      details: { reason: 'provider_instance_unallocated' },
    });
    expect(local).not.toHaveBeenCalled();
    expect(bound).not.toHaveBeenCalled();
    expect(shutdownTarget).not.toHaveBeenCalled();
  });
}

test.each(['tenant', 'cwd'] as const)(
  'shutdown hides a holder outside the caller %s scope',
  async (kind) => {
    const world = scenario('android', true);
    world.sessionStore.get('test')!.sessionScope = { kind, id: 'foreign-scope' };
    world.req.command = 'shutdown';
    world.req.session = 'default';
    world.req.meta = {
      ...world.req.meta,
      ...(kind === 'tenant'
        ? { sessionIsolation: 'tenant' as const }
        : { cwd: '/workspace/current' }),
    };
    mockResolveTargetDevice.mockResolvedValue(world.binding.device);
    const response = await handleShutdownCommand({
      host: createTestHostEnvironment(),
      req: world.req,
      sessionName: 'other',
      sessionStore: world.sessionStore,
      platformServices: daemonPlatformServicesFixture(),
      inspectFacts: async () => world.binding.facts,
    });
    expect(response).toMatchObject({ ok: false, error: { code: 'DEVICE_IN_USE' } });
    if (!response.ok) {
      expect(response.error.details).not.toHaveProperty('hint');
      expect(response.error.details).not.toHaveProperty('session');
    }
    expect(world.release).not.toHaveBeenCalled();
  },
);

test('local finalization failure retires the session instead of offering a provider retry', async () => {
  const world = scenario('android', true);
  Object.assign(world.binding, { owner: localRuntimeOwner('android') });
  world.sessionStore.get('test')!.lease = undefined;
  world.req.meta = {};
  vi.spyOn(world.binding.operations, 'finalizeApplicationClose').mockRejectedValueOnce(
    new Error('Local cleanup failed'),
  );
  await expect(world.run()).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: expect.stringContaining('Local cleanup failed'),
  });
  expect(world.sessionStore.get('test')).toBeUndefined();
  expect(world.release).not.toHaveBeenCalled();
});
