import assert from 'node:assert/strict';
import { test } from 'vitest';
import { handleLeaseCommands } from './lease.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import type { DeviceLease } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { withTestDeviceInventory } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { IOS_SIMULATOR, createTestHostEnvironment } from '@agent-device/test-kit';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';

const SECOND_IOS_SIMULATOR: DeviceInfo = { ...IOS_SIMULATOR, id: 'sim-2', name: 'iPhone 16' };
const IDENTITY_PIN = {
  selector: { platform: 'ios', udid: IOS_SIMULATOR.id },
  source: { kind: 'project', path: '/project/agent-device.json' },
} as const;

function proxyAllocateRequest(
  flags: DaemonRequest['flags'],
  meta: NonNullable<DaemonRequest['meta']>,
): DaemonRequest {
  return {
    token: 'token',
    session: 'default',
    command: 'lease_allocate',
    positionals: [],
    flags,
    meta: {
      tenantId: 'tenant-a',
      runId: 'run-1',
      leaseBackend: 'ios-instance',
      leaseProvider: 'proxy',
      clientId: 'client-1',
      ...meta,
    },
  };
}

async function allocateAgainstInventory(
  req: DaemonRequest,
  devices: readonly DeviceInfo[],
  leaseRegistry = new LeaseRegistry(),
): Promise<{ lease: DeviceLease }> {
  const response = await withTestDeviceInventory({ local: async () => devices }, async () =>
    handleLeaseCommands({
      host: createTestHostEnvironment(),
      req,
      sessionName: req.session,
      sessionStore: makeSessionStore('agent-device-pinned-proxy-allocation-'),
      leaseRegistry,
    }),
  );
  assert.ok(response?.ok);
  const lease = response.data?.lease as DeviceLease | undefined;
  assert.ok(lease);
  return { lease };
}

for (const platform of ['ios', 'macos'] as const) {
  test(`a proxy allocation preserves its ${platform} pin under an Apple-family selector`, async () => {
    const mac: DeviceInfo = {
      ...IOS_SIMULATOR,
      id: 'mac-1',
      name: 'Mac',
      appleOs: 'macos',
      kind: 'device',
      target: 'desktop',
    };
    const result = await allocateAgainstInventory(
      proxyAllocateRequest(
        { platform: 'apple' },
        {
          devicePin: {
            selector: { platform },
            source: { kind: 'project', path: '/project/agent-device.json' },
          },
        },
      ),
      [mac, IOS_SIMULATOR],
    );
    assert.equal(
      result.lease.deviceKey,
      platform === 'ios' ? 'ios:mobile:sim-1' : 'macos:desktop:mac-1',
    );
  });
}

test('a proxy allocation rejects a selected identity outside the pinned name before allocating', async () => {
  const registry = new LeaseRegistry();
  await assert.rejects(
    allocateAgainstInventory(
      proxyAllocateRequest(
        { platform: 'ios', udid: SECOND_IOS_SIMULATOR.id },
        {
          devicePin: {
            selector: { platform: 'ios', device: IOS_SIMULATOR.name },
            source: { kind: 'project', path: '/project/agent-device.json' },
          },
        },
      ),
      [IOS_SIMULATOR, SECOND_IOS_SIMULATOR],
      registry,
    ),
    (error: AppError) =>
      error.code === 'INVALID_ARGS' &&
      error.details?.reason === 'device_pin_conflict' &&
      error.details?.pinSource === 'project config file /project/agent-device.json',
  );
  assert.deepEqual(registry.listActiveLeases(), []);
});

test('a proxy allocation admits a matching explicit key and refuses other keys before allocating', async () => {
  const registry = new LeaseRegistry();
  for (const [leaseProvider, deviceKey] of [
    ['proxy', 'ios:mobile:sim-2'],
    [' proxy ', 'ios:mobile:sim-2'],
    ['proxy', 'ios:mobile:missing'],
  ]) {
    await assert.rejects(
      allocateAgainstInventory(
        proxyAllocateRequest({}, { leaseProvider, deviceKey, devicePin: IDENTITY_PIN }),
        [IOS_SIMULATOR, SECOND_IOS_SIMULATOR],
        registry,
      ),
      (error: AppError) => error.details?.reason === 'device_pin_conflict',
    );
    assert.deepEqual(registry.listActiveLeases(), []);
  }
  const { lease } = await allocateAgainstInventory(
    proxyAllocateRequest({}, { deviceKey: ' ios:mobile:sim-1 ', devicePin: IDENTITY_PIN }),
    [IOS_SIMULATOR, SECOND_IOS_SIMULATOR],
    registry,
  );
  assert.equal(lease.deviceKey, 'ios:mobile:sim-1');
});

test('a pinned proxy retry validates the existing key before renewing its lease', async () => {
  let now = 1_000;
  const registry = new LeaseRegistry({ now: () => now });
  const { lease } = await allocateAgainstInventory(
    proxyAllocateRequest({}, { deviceKey: 'ios:mobile:sim-2' }),
    [IOS_SIMULATOR, SECOND_IOS_SIMULATOR],
    registry,
  );
  now += 1_000;
  await assert.rejects(
    allocateAgainstInventory(
      proxyAllocateRequest({}, { leaseId: lease.leaseId, devicePin: IDENTITY_PIN }),
      [IOS_SIMULATOR, SECOND_IOS_SIMULATOR],
      registry,
    ),
    (error: AppError) => error.details?.reason === 'device_pin_conflict',
  );
  assert.deepEqual(registry.listActiveLeases(), [lease]);
  const { lease: renewed } = await allocateAgainstInventory(
    proxyAllocateRequest(
      {},
      {
        leaseId: lease.leaseId.toUpperCase(),
        devicePin: {
          ...IDENTITY_PIN,
          selector: { platform: 'ios', udid: SECOND_IOS_SIMULATOR.id },
        },
      },
    ),
    [IOS_SIMULATOR, SECOND_IOS_SIMULATOR],
    registry,
  );
  assert.equal(renewed.leaseId, lease.leaseId);
  assert.ok(renewed.expiresAt > lease.expiresAt);
});
