import { describe, expect, it, vi } from 'vitest';
import {
  applicationLifecycleOperationFacts,
  createUnavailablePlatformRuntimeFacts,
  localRuntimeOwner,
  narrowDeviceBinding,
  providerRuntimeOwner,
  type DeviceBinding,
  type PlatformRuntimeOperations,
  type RuntimeFacts,
  type RuntimeOperationUnavailability,
  type RuntimeOwnerRef,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { resolveBoundGetRuntime } from '../get-runtime.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import type { SessionState } from '../types.ts';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';

const available = Object.freeze({ available: true } as const);

function unavailableFact(reason: RuntimeOperationUnavailability['reason'], hint?: string) {
  return Object.freeze({ available: false, reason, ...(hint ? { hint } : {}) } as const);
}

function facts(
  device: DeviceInfo,
  owner: RuntimeOwnerRef,
  operations: Readonly<{
    captureSnapshot: RuntimeFacts<PlatformRuntimeOperations>['operations']['captureSnapshot'];
    readTextAtPoint: RuntimeFacts<PlatformRuntimeOperations>['operations']['readTextAtPoint'];
  }>,
): RuntimeFacts<PlatformRuntimeOperations> {
  const missing = unavailableFact('owner-capability-missing');
  const base = createUnavailablePlatformRuntimeFacts(device, owner, {
    appLog: missing,
    network: missing,
    viewport: missing,
    elementText: missing,
    lifecycle: applicationLifecycleOperationFacts({
      resolveOpenTarget: missing,
      prepareApplicationOpen: missing,
      openApplication: missing,
      applyRuntimeHints: missing,
      clearRuntimeHints: missing,
      closeApplication: missing,
      finalizeApplicationClose: missing,
      prepareAppleRunner: missing,
      configureProviderPortReverse: missing,
    }),
  });
  return Object.freeze({
    device: base.device,
    operations: { ...base.operations, ...operations },
  });
}

function harness(
  options: Readonly<{
    owner?: RuntimeOwnerRef;
    captureSnapshot?: RuntimeFacts<PlatformRuntimeOperations>['operations']['captureSnapshot'];
    readTextAtPoint?: RuntimeFacts<PlatformRuntimeOperations>['operations']['readTextAtPoint'];
  }> = {},
) {
  const owner = options.owner ?? localRuntimeOwner('apple');
  const operations = {
    captureSnapshot: options.captureSnapshot ?? available,
    readTextAtPoint: options.readTextAtPoint ?? available,
  };
  const captureSnapshot = vi.fn(async () => ({ backend: 'xctest', nodes: [] }) as never);
  const readTextAtPoint = vi.fn(async () => 'live text');
  const inspectFacts = vi.fn(async (device: DeviceInfo) =>
    facts(device, owner, operations),
  ) as InspectDeviceRuntimeFacts;
  const bindDevice = vi.fn(async (device: DeviceInfo, use) => {
    const binding = Object.freeze({
      device,
      owner,
      facts: facts(device, owner, operations),
      operations: Object.freeze({
        ...(operations.captureSnapshot.available ? { captureSnapshot } : {}),
        ...(operations.readTextAtPoint.available ? { readTextAtPoint } : {}),
      }),
      [Symbol.asyncDispose]: async () => undefined,
    }) as unknown as DeviceBinding<PlatformRuntimeOperations>;
    return narrowDeviceBinding(binding, use);
  }) as BindDeviceRuntime;
  return { inspectFacts, bindDevice, captureSnapshot, readTextAtPoint };
}

function session(): SessionState {
  return makeIosSession('get-runtime', { appBundleId: 'com.example.app' });
}

describe('resolveBoundGetRuntime', () => {
  it('refuses without an active session before touching facts or binding', async () => {
    const seams = harness();
    const resolved = await resolveBoundGetRuntime({ session: undefined, ...seams });
    expect(resolved.ok).toBe(false);
    expect(seams.inspectFacts).not.toHaveBeenCalled();
    expect(seams.bindDevice).not.toHaveBeenCalled();
  });

  it('inspects owner facts exactly once and binds exactly once', async () => {
    const seams = harness();
    const resolved = await resolveBoundGetRuntime({ session: session(), ...seams });
    expect(resolved.ok).toBe(true);
    expect(seams.inspectFacts).toHaveBeenCalledTimes(1);
    expect(seams.bindDevice).toHaveBeenCalledTimes(1);
  });

  it('binds the admitted device with the element-read use', async () => {
    const seams = harness();
    const active = session();
    await resolveBoundGetRuntime({ session: active, ...seams });
    const [boundDevice, use] = vi.mocked(seams.bindDevice).mock.calls[0] ?? [];
    expect(boundDevice?.id).toBe(active.device.id);
    expect(use).toEqual({ required: ['captureSnapshot'], preferred: ['readTextAtPoint'] });
  });

  it('refuses before binding when the required capture is unavailable', async () => {
    const seams = harness({
      captureSnapshot: unavailableFact('unsupported-platform-leaf', 'no snapshot backend'),
    });
    const resolved = await resolveBoundGetRuntime({ session: session(), ...seams });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok && !resolved.response.ok) {
      expect(resolved.response.error.code).toBe('UNSUPPORTED_OPERATION');
      expect(resolved.response.error.hint).toBe('no snapshot backend');
    }
    expect(seams.inspectFacts).toHaveBeenCalledTimes(1);
    expect(seams.bindDevice).not.toHaveBeenCalled();
  });

  it('still admits and binds when only the preferred read is unavailable', async () => {
    const seams = harness({ readTextAtPoint: unavailableFact('unsupported-platform-leaf') });
    const resolved = await resolveBoundGetRuntime({ session: session(), ...seams });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.operations.captureSnapshot).toBeTypeOf('function');
      expect(resolved.operations.readTextAtPoint).toBeUndefined();
    }
    expect(seams.bindDevice).toHaveBeenCalledTimes(1);
  });

  it('exposes the preferred read when the owner advertises it', async () => {
    const seams = harness();
    const resolved = await resolveBoundGetRuntime({ session: session(), ...seams });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      await resolved.operations.readTextAtPoint?.({ point: { x: 1, y: 2 } });
      expect(seams.readTextAtPoint).toHaveBeenCalledTimes(1);
    }
  });

  // Provider ownership is authoritative: an unavailable provider fact fails closed rather than
  // borrowing the local family runtime.
  it('fails closed for a provider owner whose facts refuse the capture', async () => {
    const seams = harness({
      owner: providerRuntimeOwner('webdriver', 'tenant-a'),
      captureSnapshot: unavailableFact('unsupported-provider-mode'),
    });
    const resolved = await resolveBoundGetRuntime({ session: session(), ...seams });
    expect(resolved.ok).toBe(false);
    expect(seams.bindDevice).not.toHaveBeenCalled();
  });

  it('binds a provider owner that advertises capture but no live read', async () => {
    const seams = harness({
      owner: providerRuntimeOwner('webdriver', 'tenant-a'),
      readTextAtPoint: unavailableFact('unsupported-provider-mode'),
    });
    const resolved = await resolveBoundGetRuntime({ session: session(), ...seams });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.operations.readTextAtPoint).toBeUndefined();
  });

  it('refuses to bind without a runtime gateway', async () => {
    const seams = harness();
    await expect(
      resolveBoundGetRuntime({ session: session(), inspectFacts: seams.inspectFacts }),
    ).rejects.toThrow(/binding is unavailable/i);
  });
});
