import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createProviderDeviceRuntimeRequestProviders,
  type ProviderDeviceRuntime,
} from '../../../src/provider-device-runtime.ts';
import type {
  DeviceInventoryProvider,
  DeviceLease,
  LeaseLifecycleProvider,
} from '../../../src/contracts/device-provider.ts';
import type { Interactor, RunnerContext } from '../../../src/contracts/interactor-types.ts';
import type { DaemonRequest } from '../../../src/daemon/types.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createAppleInteractor } from '../../../src/platforms/apple/interactor.ts';
import type { RunnerCommand } from '../../../src/platforms/apple/core/runner/runner-contract.ts';
import type {
  AppleRunnerCommandOptions,
  AppleRunnerProvider,
} from '../../../src/platforms/apple/core/runner/runner-provider.ts';
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

type RecordedRunnerCall = { command: RunnerCommand; options: AppleRunnerCommandOptions };
type RunnerTransportCalls = { runner: RecordedRunnerCall[]; opens: number };

// Issue #1297 acceptance path: a provider that only supplies an
// AppleRunnerProvider transport (plus its own `open`) reuses the SHARED Apple
// interactor — selector resolution, tap, fill, and snapshot all arrive at the
// provider transport as runner-protocol commands instead of local XCTest.
// This world has NO request-boundary resolver, so the interactor's injected
// transport is the only thing keeping runner traffic off the local runtime:
// removing the createAppleInteractor provider param fails this test.
test('provider-supplied Apple runner transport reuses the shared interactor stack', async () => {
  await withProviderScenarioResource(createInteractorSeamWorld, async ({ daemon, calls }) => {
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
    const tap = calls.runner.find((call) => call.command.command === 'tap');
    assert.ok(tap, 'expected a runner-protocol tap on the provider transport');
    // The shared runtime resolved the selector against the transport's snapshot
    // and tapped the element center, whichever tap vehicle it picked.
    assert.deepEqual({ x: tap.command.x, y: tap.command.y }, { x: 60, y: 30 });

    assertRpcOk(
      await daemon.callCommand('fill', ['label="Provider Input"', 'hello'], request.flags, request),
    );
    const fill = calls.runner.find(
      (call) => call.command.command === 'type' && call.command.textEntryMode === 'replace',
    );
    assert.ok(fill, 'expected a runner-protocol fill on the provider transport');
    assert.equal(fill.command.text, 'hello');
    assert.deepEqual({ x: fill.command.x, y: fill.command.y }, { x: 60, y: 90 });

    const snapshots = calls.runner.filter((call) => call.command.command === 'snapshot');
    assert.ok(
      snapshots.length >= 4,
      `expected shared snapshot runtime traffic on the transport, got ${snapshots.length}`,
    );
  });
});

// Daemon routes that issue runner commands OUTSIDE interactor methods (keyboard,
// native alert, point read, iOS sequences) must reach the provider transport via
// the request-boundary `appleRunnerProvider` scope instead of escaping to the
// local XCTest runtime — and that scope must preserve the request's id, since
// scoped-provider resolution requires the scope and call requestIds to match.
test('daemon direct runner routes reach the provider transport through the request scope', async () => {
  await withProviderScenarioResource(createRequestScopeWorld, async ({ daemon, calls }) => {
    const lease = await allocateLease(daemon);
    const flags = leaseFlags(lease.leaseId);
    assertRpcOk(
      await daemon.callCommand('open', ['com.example.app'], flags, {
        meta: leaseMeta(lease.leaseId),
      }),
    );

    calls.runner.length = 0;
    const keyboardMeta = { ...leaseMeta(lease.leaseId), requestId: 'req-keyboard-1' };
    assertRpcOk(await daemon.callCommand('keyboard', ['dismiss'], flags, { meta: keyboardMeta }));
    const dismiss = calls.runner.find((call) => call.command.command === 'keyboardDismiss');
    assert.ok(dismiss, 'expected keyboardDismiss on the provider transport, not local XCTest');
    assert.equal(
      dismiss.options.requestId,
      'req-keyboard-1',
      'direct-route runner call lost the per-request id across the request-boundary scope',
    );
  });
});

// Per-request RunnerContext threading: the daemon builds the interactor per
// request, so runner calls carry the request's id (cancellation/accounting)
// instead of the construction-time context. Runs without the request-boundary
// resolver so the id can only arrive via getInteractor's runnerContext.
test('provider transport runner calls carry the per-request id', async () => {
  await withProviderScenarioResource(createInteractorSeamWorld, async ({ daemon, calls }) => {
    const lease = await allocateLease(daemon);
    const flags = leaseFlags(lease.leaseId);
    const openMeta = { ...leaseMeta(lease.leaseId), requestId: 'req-open-1' };
    assertRpcOk(await daemon.callCommand('open', ['com.example.app'], flags, { meta: openMeta }));

    calls.runner.length = 0;
    const clickMeta = { ...leaseMeta(lease.leaseId), requestId: 'req-click-1' };
    assertRpcOk(
      await daemon.callCommand('click', ['label="Provider Ready"'], flags, { meta: clickMeta }),
    );
    assert.ok(calls.runner.length >= 1, 'expected runner traffic for the click request');
    for (const call of calls.runner) {
      assert.equal(
        call.options.requestId,
        'req-click-1',
        `runner ${call.command.command} lost the per-request id`,
      );
    }
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

// The interactor seam alone: no getAppleRunnerProvider, so nothing scopes the
// request — only the transport injected into createAppleInteractor routes.
async function createInteractorSeamWorld() {
  return await createRunnerTransportWorld({ requestScope: false });
}

// The request-boundary seam: getAppleRunnerProvider scopes the whole request,
// covering runner commands issued outside interactor methods.
async function createRequestScopeWorld() {
  return await createRunnerTransportWorld({ requestScope: true });
}

async function createRunnerTransportWorld(options: { requestScope: boolean }) {
  const calls: RunnerTransportCalls = { runner: [], opens: 0 };
  const runtime = createProviderRuntime(calls, options);
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

function createProviderRuntime(
  calls: RunnerTransportCalls,
  options: { requestScope: boolean },
): ProviderDeviceRuntime {
  const transport: AppleRunnerProvider = {
    runCommand: async (_device, command, options) => {
      calls.runner.push({ command, options });
      return runnerResultFor(command);
    },
  };
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
    getInteractor: (device, runnerContext) =>
      device.id === DEVICE.id
        ? createRunnerTransportInteractor(calls, transport, runnerContext)
        : undefined,
    ...(options.requestScope
      ? {
          getAppleRunnerProvider: (device: DeviceInfo) =>
            device.id === DEVICE.id ? transport : undefined,
        }
      : {}),
    shutdown: async () => undefined,
  };
}

function createRunnerTransportInteractor(
  calls: RunnerTransportCalls,
  transport: AppleRunnerProvider,
  runnerContext: RunnerContext | undefined,
): Interactor {
  return {
    ...createAppleInteractor(DEVICE, runnerContext ?? {}, transport),
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
