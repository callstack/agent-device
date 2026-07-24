import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createProviderDeviceRuntimeRequestProviders,
  type ProviderDeviceRuntime,
} from '../../../src/provider-device-runtime.ts';
import type { DeviceInventoryProvider } from '../../../src/core/dispatch-resolve.ts';
import type { Interactor } from '../../../src/core/interactor-types.ts';
import type { LeaseLifecycleProvider } from '../../../src/daemon/handlers/lease.ts';
import type { DeviceLease } from '../../../src/daemon/lease-registry.ts';
import type { DaemonRequest } from '../../../src/daemon/types.ts';
import type { DeviceInfo } from '../../../src/kernel/device.ts';
import { createAppleInteractor } from '../../../src/platforms/apple/interactor.ts';
import type { RunnerCommand } from '../../../src/platforms/apple/core/runner/runner-contract.ts';
import type { AppleRunnerProvider } from '../../../src/platforms/apple/core/runner/runner-provider.ts';
import { assertRpcOk } from './assertions.ts';
import { createProviderScenarioHarness, withProviderScenarioResource } from './harness.ts';

const PROVIDER = 'fake-ios-runner-provider';
const DEVICE: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'fake-ios-runner-provider:simulator-1',
  name: 'Fake Runner Transport iOS Simulator',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

// Issue #1297 acceptance path: a provider that only supplies an
// AppleRunnerProvider transport (plus its own `open`) reuses the SHARED Apple
// interactor — selector resolution, tap, fill, and snapshot all arrive at the
// provider transport as runner-protocol commands instead of local XCTest.
test('provider-supplied Apple runner transport reuses the shared interactor stack', async () => {
  await withProviderScenarioResource(createRunnerTransportWorld, async ({ daemon, calls }) => {
    const lease = await allocateLease(daemon);
    const request = { flags: leaseFlags(lease.leaseId), meta: leaseMeta(lease.leaseId) };

    assertRpcOk(await daemon.callCommand('open', ['com.example.app'], request.flags, request));
    assert.equal(calls.opens, 1);

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

    assertRpcOk(
      await daemon.callCommand('click', ['label="Provider Ready"'], request.flags, request),
    );
    const tap = calls.commands.find((command) => command.command === 'tap');
    assert.ok(tap, 'expected a runner-protocol tap on the provider transport');
    // The shared runtime resolved the selector against the transport's snapshot
    // and tapped the element center, whichever tap vehicle it picked.
    assert.deepEqual({ x: tap.x, y: tap.y }, { x: 60, y: 30 });

    assertRpcOk(
      await daemon.callCommand('fill', ['label="Provider Input"', 'hello'], request.flags, request),
    );
    const fill = calls.commands.find(
      (command) => command.command === 'type' && command.textEntryMode === 'replace',
    );
    assert.ok(fill, 'expected a runner-protocol fill on the provider transport');
    assert.equal(fill.text, 'hello');
    assert.deepEqual({ x: fill.x, y: fill.y }, { x: 60, y: 90 });

    const snapshots = calls.commands.filter((command) => command.command === 'snapshot');
    assert.ok(
      snapshots.length >= 4,
      `expected shared snapshot runtime traffic on the transport, got ${snapshots.length}`,
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

async function createRunnerTransportWorld() {
  const calls = { commands: [] as RunnerCommand[], opens: 0 };
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
  commands: RunnerCommand[];
  opens: number;
}): ProviderDeviceRuntime {
  const interactor = createRunnerTransportInteractor(calls);
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

function createRunnerTransportInteractor(calls: {
  commands: RunnerCommand[];
  opens: number;
}): Interactor {
  const transport: AppleRunnerProvider = {
    runCommand: async (_device, command) => {
      calls.commands.push(command);
      return runnerResultFor(command);
    },
  };
  return {
    ...createAppleInteractor(DEVICE, {}, transport),
    // App lifecycle stays provider-owned: the transport seam covers runner
    // commands only, so the provider composes its own `open` on top.
    open: async () => {
      calls.opens += 1;
    },
  };
}

function runnerResultFor(command: RunnerCommand): Record<string, unknown> {
  switch (command.command) {
    case 'snapshot':
      return {
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
    case 'tap':
      return { x: command.x, y: command.y };
    default:
      return {};
  }
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
