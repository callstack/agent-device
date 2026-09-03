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
  gatewayFixtureScope as scope,
  localFamilyRuntimeFixture,
  MANAGED_RETAINED_OPERATION,
  MANAGED_WITHHELD_OPERATIONS,
} from './platform-runtime-gateway.fixtures.ts';

const managed = managedLocalRuntimeOwner('sim-a');
const fence = managedBindingFence({
  requesterId: 'requester-a',
  requestGeneration: 1,
  identityIncarnationId: 'incarnation-a',
});

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
  test('withholds every lifecycle-bearing and durable capture cell and keeps the rest', async () => {
    const { owner } = managedOwnerFixture();

    const binding = await owner.bind({ device, intent: exactly(), scope });

    // A cell dropped from this list would silently stop being covered by the assertions below.
    expect(MANAGED_WITHHELD_OPERATIONS).toHaveLength(27);
    for (const key of MANAGED_WITHHELD_OPERATIONS) {
      expect(binding.facts.operations[key]).toMatchObject({
        available: false,
        reason: 'owner-capability-missing',
      });
      expect(binding.operations[key]).toBeUndefined();
    }
    expect(binding.facts.operations[MANAGED_RETAINED_OPERATION]).toEqual({ available: true });
    expect(binding.operations[MANAGED_RETAINED_OPERATION]).toBeTypeOf('function');
  });

  // The exclusion covers binding cells only. Pre-binding readiness still boots a device through
  // direct platform tooling before any binding exists; moving it under the binding is its own unit.
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
    // `deployAppUse` requires `deployApp` alone, so only the cell itself can refuse `install`.
    expect(thrownBy(() => narrowDeviceBinding(binding, deployAppUse))).toMatchObject(refused);
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

  test('does not read the fence: what a managed fence proves belongs to the claim gate', async () => {
    const { owner } = managedOwnerFixture();

    const binding = await owner.bind({
      device,
      intent: exactly(managed, { token: 'an-opaque-capture-token', generation: 7 }),
      scope,
    });

    expect(binding.owner).toEqual(managed);
  });

  test('never claims a device and projects the same withholding onto inspected facts', async () => {
    const { owner } = managedOwnerFixture();

    expect(owner.ownsDevice(device)).toBe(false);
    const facts = await owner.inspectFacts(device);
    expect(facts.operations.bootTarget).toMatchObject({
      available: false,
      reason: 'owner-capability-missing',
    });
    expect(facts.operations[MANAGED_RETAINED_OPERATION]).toEqual({ available: true });
  });

  test('reports the family owner provider mode it was given, unlaundered', async () => {
    const { owner } = managedOwnerFixture('transport-composed');

    const binding = await owner.bind({ device, intent: exactly(), scope });

    expect(binding.facts.device.providerMode).toBe('transport-composed');
  });
});
