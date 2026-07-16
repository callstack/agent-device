import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createProviderDeviceRuntimeRequestProviders,
  type ProviderDeviceRuntime,
} from '../../../src/provider-device-runtime.ts';
import type { DeviceInventoryProvider } from '../../../src/core/dispatch-resolve.ts';
import type { Interactor, SnapshotResult } from '../../../src/core/interactor-types.ts';
import type { LeaseLifecycleProvider } from '../../../src/daemon/handlers/lease.ts';
import type { DeviceLease } from '../../../src/daemon/lease-registry.ts';
import type { DaemonRequest } from '../../../src/daemon/types.ts';
import type { DeviceInfo } from '../../../src/kernel/device.ts';
import { assertRpcOk } from './assertions.ts';
import { createProviderScenarioHarness, withProviderScenarioResource } from './harness.ts';

const PROVIDER = 'fake-ios-provider';
const DEVICE: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'fake-ios-provider:simulator-1',
  name: 'Fake Provider iOS Simulator',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

test('provider-owned iOS selectors use the shared interactor runtime instead of local XCTest', async () => {
  await withProviderScenarioResource(createProviderIosSelectorWorld, async ({ daemon, calls }) => {
    const lease = await allocateLease(daemon);
    const request = { flags: leaseFlags(lease.leaseId), meta: leaseMeta(lease.leaseId) };

    assertRpcOk(await daemon.callCommand('open', ['com.example.app'], request.flags, request));
    assert.match(
      String(
        assertRpcOk(
          await daemon.callCommand(
            'get',
            ['text', 'label="Provider Ready"'],
            request.flags,
            request,
          ),
        ).text,
      ),
      /^Provider Ready$/,
    );
    assert.equal(
      assertRpcOk(
        await daemon.callCommand(
          'is',
          ['exists', 'label="Provider Ready"'],
          request.flags,
          request,
        ),
      ).pass,
      true,
    );
    assertRpcOk(
      await daemon.callCommand('wait', ['label="Provider Ready"'], request.flags, request),
    );
    assertRpcOk(await daemon.callCommand('wait', ['Provider Ready'], request.flags, request));

    const click = assertRpcOk(
      await daemon.callCommand('click', ['label="Provider Ready"'], request.flags, request),
    );
    assert.equal(click.x, 60);
    assert.equal(click.y, 30);
    const fill = assertRpcOk(
      await daemon.callCommand('fill', ['label="Provider Input"', 'hello'], request.flags, request),
    );
    assert.equal(fill.x, 60);
    assert.equal(fill.y, 90);

    assert.deepEqual(calls.taps, [{ x: 60, y: 30 }]);
    assert.deepEqual(calls.fills, [{ x: 60, y: 90, text: 'hello' }]);
    assert.ok(
      calls.snapshots >= 5,
      `expected shared snapshot runtime calls, got ${calls.snapshots}`,
    );
  });
});

async function allocateLease(
  daemon: Awaited<ReturnType<typeof createProviderScenarioHarness>>,
): Promise<DeviceLease> {
  const response = await daemon.callCommand('lease_allocate', [], leaseFlags(), {
    meta: leaseMeta(),
  });
  return assertRpcOk<{ lease: DeviceLease }>(response).lease;
}

async function createProviderIosSelectorWorld() {
  const calls = {
    snapshots: 0,
    taps: [] as Array<{ x: number; y: number }>,
    fills: [] as Array<{ x: number; y: number; text: string }>,
  };
  const runtime = createProviderRuntime(calls);
  const providers = createProviderDeviceRuntimeRequestProviders([runtime]);
  const daemon = await createProviderScenarioHarness({
    ...providers,
    deviceInventoryProvider: providers.deviceInventoryProvider!,
  });
  return {
    daemon,
    calls,
    close: async () => {
      await runtime.shutdown();
      await daemon.close();
    },
  };
}

function createProviderRuntime(calls: {
  snapshots: number;
  taps: Array<{ x: number; y: number }>;
  fills: Array<{ x: number; y: number; text: string }>;
}): ProviderDeviceRuntime {
  const interactor = createProviderInteractor(calls);
  const leaseLifecycle: LeaseLifecycleProvider = {
    allocate: async (lease) =>
      lease.leaseProvider === PROVIDER ? { provider: PROVIDER, deviceId: DEVICE.id } : undefined,
  };
  const deviceInventoryProvider: DeviceInventoryProvider = async (request) =>
    request.leaseProvider === PROVIDER && request.leaseId ? [DEVICE] : null;
  return {
    provider: PROVIDER,
    leaseLifecycle,
    deviceInventoryProvider,
    ownsDevice: (device) => device.id === DEVICE.id,
    getInteractor: (device) => (device.id === DEVICE.id ? interactor : undefined),
    shutdown: async () => undefined,
  };
}

function createProviderInteractor(calls: {
  snapshots: number;
  taps: Array<{ x: number; y: number }>;
  fills: Array<{ x: number; y: number; text: string }>;
}): Interactor {
  return new Proxy<Partial<Interactor>>(
    {
      open: async () => undefined,
      tap: async (x, y) => {
        calls.taps.push({ x, y });
        return { x, y };
      },
      fill: async (x, y, text) => {
        calls.fills.push({ x, y, text });
        return { x, y, text };
      },
      snapshot: async (): Promise<SnapshotResult> => {
        calls.snapshots += 1;
        return {
          backend: 'xctest',
          nodes: [
            {
              index: 0,
              type: 'Application',
              label: 'Example',
              rect: { x: 0, y: 0, width: 400, height: 800 },
            },
            {
              index: 1,
              parentIndex: 0,
              type: 'Button',
              label: 'Provider Ready',
              hittable: true,
              rect: { x: 20, y: 10, width: 80, height: 40 },
            },
            {
              index: 2,
              parentIndex: 0,
              type: 'TextField',
              label: 'Provider Input',
              hittable: true,
              rect: { x: 20, y: 70, width: 80, height: 40 },
            },
          ],
        };
      },
    },
    {
      get(target, property, receiver) {
        if (
          property === 'then' ||
          property === 'tapElementSelector' ||
          property === 'fillElementSelector'
        ) {
          return undefined;
        }
        if (property in target) return Reflect.get(target, property, receiver);
        return () => {
          throw new Error(`Unexpected provider iOS interactor call: ${String(property)}`);
        };
      },
    },
  ) as Interactor;
}

function leaseFlags(leaseId?: string): DaemonRequest['flags'] {
  return {
    platform: 'ios',
    tenant: 'team-a',
    runId: 'run-a',
    leaseId,
    leaseProvider: PROVIDER,
  };
}

function leaseMeta(leaseId?: string): DaemonRequest['meta'] {
  return {
    tenantId: 'team-a',
    runId: 'run-a',
    leaseId,
    leaseBackend: 'ios-instance',
    leaseProvider: PROVIDER,
    deviceKey: DEVICE.id,
    clientId: 'client-a',
  };
}
