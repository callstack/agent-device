import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import type { DeviceRuntimeGateway, RuntimeFacts } from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { createTouchCommandSurface } from '../../__tests__/support/touch-command-surface-fake.ts';
import {
  createRequestHandler,
  gestureRuntimeSpies,
  lifecycleDeviceRuntimeGateway,
} from '../../__tests__/support/test-device-runtime-gateway.ts';
import { makeIosAppSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';

vi.mock('../../core/device/device-ready.ts', () => ({
  ensureDeviceReady: vi.fn(async () => {}),
}));

const tapPoint = vi.fn(async () => undefined);

function withTapPoint(
  facts: RuntimeFacts<PlatformRuntimeOperations>,
): RuntimeFacts<PlatformRuntimeOperations> {
  return { ...facts, operations: { ...facts.operations, tapPoint: { available: true } } };
}

const gateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
  inspectFacts: async (device) =>
    withTapPoint(await lifecycleDeviceRuntimeGateway.inspectFacts(device)),
  bind: async (request) => {
    const binding = await lifecycleDeviceRuntimeGateway.bind(request);
    return {
      ...binding,
      facts: withTapPoint(binding.facts),
      operations: { ...binding.operations, tapPoint },
    };
  },
  shutdown: async () => {},
};

test('a find click on a leased session sends the lease id on the click it runs', async () => {
  const sessionStore = makeSessionStore('agent-device-router-find-lease-');
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'proxy',
    clientId: 'client-a',
    deviceKey: 'ios:SIM-001',
  });
  sessionStore.publish(
    'default',
    makeIosAppSession('default', {
      lease: {
        leaseId: lease.leaseId,
        tenantId: lease.tenantId,
        runId: lease.runId,
        leaseBackend: lease.backend,
        leaseProvider: 'proxy',
        clientId: 'client-a',
        deviceKey: 'ios:SIM-001',
      },
    }),
  );
  gestureRuntimeSpies.captureSnapshot.mockResolvedValue({
    backend: 'xctest',
    producer: 'apple-runner',
    nodes: [
      {
        index: 0,
        type: 'XCUIElementTypeButton',
        label: 'Continue',
        rect: { x: 10, y: 20, width: 100, height: 40 },
        enabled: true,
        hittable: true,
      },
    ],
  } as never);
  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: createTouchCommandSurface(),
    logPath: path.join(mkdtempForTestSync('agent-device-router-find-lease-log-'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: gateway,
    trackDownloadableArtifact: () => 'artifact-id',
  });

  // The owner sends the lease id only in meta, as a host that forwards per client does.
  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'find',
    positionals: ['Continue', 'click'],
    flags: {},
    meta: { leaseId: lease.leaseId },
  });

  expect(response.ok, JSON.stringify(response)).toBe(true);
  expect(tapPoint).toHaveBeenCalledTimes(1);
});
