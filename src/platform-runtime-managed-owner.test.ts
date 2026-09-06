import {
  type DeviceBindingIntent,
  type ResourceOwnershipFence,
  type RuntimeOwnerRef,
  type RuntimeProviderMode,
  localRuntimeOwner,
  managedBindingFence,
  managedLocalRuntimeOwner,
  narrowDeviceBinding,
} from '@agent-device/contracts/platform-runtime';
import {
  appStateUse,
  appsRuntimeUse,
  bootTargetUse,
  shutdownTargetUse,
  type PlatformRuntimeHost,
} from '@agent-device/contracts/platform-runtime-operations';
import { deployAppUse } from '@agent-device/contracts/app-deployment-runtime-plan';
import { describe, expect, test } from 'vitest';
import { createManagedLocalRuntimeOwner } from './platform-runtime-managed-owner.ts';
import {
  gatewayFixtureDevice as device,
  gatewayFixtureScope as ordinaryScope,
  managedGatewayScope,
  localFamilyRuntimeFixture,
  REVIEWED_MANAGED_OPERATION,
} from './platform-runtime-gateway.fixtures.ts';

const managed = managedLocalRuntimeOwner('sim-a');
const fence = managedBindingFence({
  requesterId: 'requester-a',
  requestGeneration: 1,
  identityIncarnationId: 'incarnation-a',
});

const scope = managedGatewayScope(device, managed, fence);

function exactly(
  owner: RuntimeOwnerRef = managed,
  withFence: ResourceOwnershipFence = fence,
): DeviceBindingIntent {
  return { kind: 'exact-owner', owner, fence: withFence };
}

function managedOwnerFixture(providerMode?: RuntimeProviderMode) {
  const family = localFamilyRuntimeFixture({ family: 'apple', device, providerMode });
  const owner = createManagedLocalRuntimeOwner({
    owner: managed,
    loadLocal: async () => await family.module.loadRuntime({} as PlatformRuntimeHost),
  });
  return { family, owner };
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the runtime use to be refused');
}

describe('managed local runtime owner', () => {
  test('dispatches the real operation inside admission before authority can be fenced', async () => {
    const events: string[] = [];
    const cancellation = new AbortController();
    let cancelOnAdmission = false;
    const family = localFamilyRuntimeFixture({ family: 'apple', device });
    const local = await family.module.loadRuntime({} as PlatformRuntimeHost);
    const owner = createManagedLocalRuntimeOwner({
      owner: managed,
      loadLocal: async () => ({
        ...local,
        bind: async (request) => {
          const binding = await local.bind(request);
          return {
            ...binding,
            operations: {
              ...binding.operations,
              readClipboard: async () => {
                events.push('native');
                expect(events.at(-2)).toBe('admitted');
                return 'clipboard';
              },
            },
          };
        },
      }),
    });
    const binding = await owner.bind({
      device,
      intent: exactly(),
      scope: {
        ...scope,
        signal: cancellation.signal,
        managedDevice: {
          ...scope.managedDevice!,
          admit: async (task) => {
            events.push('admitted');
            if (cancelOnAdmission) cancellation.abort(new Error('cancelled during admission'));
            try {
              return await task();
            } finally {
              events.push('fenced');
            }
          },
        },
      },
    });
    expect(await binding.operations.readClipboard!({})).toBe('clipboard');
    cancelOnAdmission = true;
    await expect(binding.operations.readClipboard!({})).rejects.toThrow(
      'cancelled during admission',
    );
    await binding[Symbol.asyncDispose]();
    expect(events).toEqual(['admitted', 'native', 'fenced', 'admitted', 'fenced']);
    expect(family.calls.disposals).toBe(1);
  });

  test('exposes only reviewed operations even when the local family offers every cell', async () => {
    const { owner } = managedOwnerFixture();

    const binding = await owner.bind({ device, intent: exactly(), scope });

    const enabled = [
      'ensureReady',
      'deployApp',
      'materializeAppSource',
      'deployMaterializedApp',
      'sendPushNotification',
      'setSetting',
      'readClipboard',
      'writeClipboard',
    ];
    expect(Object.keys(binding.operations).sort()).toEqual(enabled.sort());
    for (const key of Object.keys(binding.facts.operations) as Array<
      keyof typeof binding.facts.operations
    >) {
      if (enabled.includes(key)) continue;
      expect(binding.facts.operations[key]).toMatchObject({
        available: false,
        reason: 'owner-capability-missing',
      });
      expect(binding.operations[key]).toBeUndefined();
    }
    expect(binding.facts.operations[REVIEWED_MANAGED_OPERATION]).toEqual({ available: true });
    expect(binding.operations[REVIEWED_MANAGED_OPERATION]).toBeTypeOf('function');
  });

  // The exclusion covers binding cells; request-runtime binding owns the separate pre-binding
  // readiness fence.
  test('refuses every runtime use that needs a withheld cell', async () => {
    const { owner } = managedOwnerFixture();
    const binding = await owner.bind({ device, intent: exactly(), scope });
    const refused = {
      code: 'UNSUPPORTED_OPERATION',
      details: { reason: 'owner-capability-missing' },
    };

    expect(thrownBy(() => narrowDeviceBinding(binding, appsRuntimeUse))).toMatchObject(refused);
    expect(thrownBy(() => narrowDeviceBinding(binding, appStateUse))).toMatchObject(refused);
    expect(thrownBy(() => narrowDeviceBinding(binding, bootTargetUse))).toMatchObject(refused);
    expect(thrownBy(() => narrowDeviceBinding(binding, shutdownTargetUse))).toMatchObject(refused);
    expect(narrowDeviceBinding(binding, deployAppUse).owner).toEqual(managed);
  });

  test('rewrites the owner, delegates under an ordinary intent, and forwards disposal', async () => {
    const { family, owner } = managedOwnerFixture();

    const binding = await owner.bind({ device, intent: exactly(), scope });

    expect(binding.owner).toEqual(managed);
    expect(binding.device).toEqual(device);
    expect(family.requests).toHaveLength(1);
    expect(family.requests[0]?.intent).toEqual({ kind: 'ordinary' });
    expect(family.requests[0]?.scope).toBe(scope);
    await binding[Symbol.asyncDispose]();
    expect(family.calls.disposals).toBe(1);
  });

  test('binds only under an exact-owner intent that names this owner', async () => {
    const { family, owner } = managedOwnerFixture();
    const refusal = {
      code: 'COMMAND_FAILED',
      details: { reason: 'runtime-contract-invalid' },
    };

    await expect(owner.bind({ device, intent: { kind: 'ordinary' }, scope })).rejects.toMatchObject(
      refusal,
    );
    await expect(
      owner.bind({ device, intent: exactly(localRuntimeOwner('apple')), scope }),
    ).rejects.toMatchObject(refusal);
    await expect(
      owner.bind({ device, intent: exactly(managedLocalRuntimeOwner('sim-b')), scope }),
    ).rejects.toMatchObject(refusal);
    expect(family.requests).toEqual([]);
  });

  test('compares the opaque fence exactly while its meaning stays with the claim gate', async () => {
    const { owner } = managedOwnerFixture();

    const binding = await owner.bind({
      device,
      intent: exactly(managed, { token: 'an-opaque-capture-token', generation: 7 }),
      scope: managedGatewayScope(device, managed, {
        token: 'an-opaque-capture-token',
        generation: 7,
      }),
    });

    expect(binding.owner).toEqual(managed);
  });

  test('never claims a device and leaves unbound inspection entirely unavailable', async () => {
    const { owner } = managedOwnerFixture();

    expect(owner.ownsDevice(device)).toBe(false);
    const facts = await owner.inspectFacts(device);
    expect(facts.operations.bootTarget).toMatchObject({
      available: false,
      reason: 'owner-capability-missing',
    });
    expect(facts.operations[REVIEWED_MANAGED_OPERATION].available).toBe(false);
  });

  test('reports the family owner provider mode it was given, unlaundered', async () => {
    const { owner } = managedOwnerFixture('transport-composed');

    const binding = await owner.bind({ device, intent: exactly(), scope });

    expect(binding.facts.device.providerMode).toBe('transport-composed');
  });

  test('refuses absent or mismatched managed authority before loading local mechanics', async () => {
    const { family, owner } = managedOwnerFixture();
    for (const candidate of [
      ordinaryScope,
      managedGatewayScope({ ...device, simulatorSetPath: '/foreign' }, managed, fence),
      managedGatewayScope(device, managedLocalRuntimeOwner('foreign'), fence),
      managedGatewayScope(device, managed, { ...fence, generation: 2 }),
    ]) {
      await expect(
        owner.bind({ device, intent: exactly(), scope: candidate }),
      ).rejects.toBeDefined();
    }
    expect(family.calls.loads).toBe(0);
  });
});
