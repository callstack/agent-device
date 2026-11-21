import fs from 'node:fs';
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

const OTHER_LEASE_ID = 'f'.repeat(32);

function leasedRouter(options: { leased?: boolean } = {}) {
  const leased = options.leased ?? true;
  const sessionStore = makeSessionStore('agent-device-router-nested-lease-');
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
    makeIosAppSession(
      'default',
      leased
        ? {
            lease: {
              leaseId: lease.leaseId,
              tenantId: lease.tenantId,
              runId: lease.runId,
              leaseBackend: lease.backend,
              leaseProvider: 'proxy',
              clientId: 'client-a',
              deviceKey: 'ios:SIM-001',
            },
          }
        : {},
    ),
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
  const root = mkdtempForTestSync('agent-device-router-nested-lease-log-');
  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: createTouchCommandSurface(),
    logPath: path.join(root, 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: gateway,
    trackDownloadableArtifact: () => 'artifact-id',
  });
  return { handler, leaseId: lease.leaseId, root };
}

test('a find click on a leased session sends the lease id on the click it runs', async () => {
  const { handler, leaseId } = leasedRouter();
  tapPoint.mockClear();

  // The owner sends the lease id only in meta, as a host that forwards per client does.
  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'find',
    positionals: ['Continue', 'click'],
    flags: {},
    meta: { leaseId },
  });

  expect(response.ok, JSON.stringify(response)).toBe(true);
  expect(tapPoint).toHaveBeenCalledTimes(1);
});

test('a replay that sends the lease id in its flags runs its steps on the leased session', async () => {
  const { handler, leaseId, root } = leasedRouter();
  const script = path.join(root, 'snapshot.ad');
  fs.writeFileSync(script, 'snapshot\n');

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'replay',
    positionals: [script],
    flags: { leaseId },
    meta: { cwd: root, sessionExplicit: true },
  });

  expect(response.ok, JSON.stringify(response)).toBe(true);
});

test('a batch step that names another lease id is refused even when the batch sends the right one', async () => {
  const { handler, leaseId } = leasedRouter();

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'batch',
    positionals: [],
    flags: {
      leaseId,
      batchSteps: [{ command: 'snapshot', positionals: [], flags: { leaseId: OTHER_LEASE_ID } }],
    },
  });

  expect(response.ok, JSON.stringify(response)).toBe(false);
  expect(JSON.stringify(response)).toContain('LEASE_SESSION_MISMATCH');
});

test('a batch step that names another lease id is refused when the batch sends the right one in meta', async () => {
  const { handler, leaseId } = leasedRouter();

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'batch',
    positionals: [],
    flags: {
      batchSteps: [{ command: 'snapshot', positionals: [], flags: { leaseId: OTHER_LEASE_ID } }],
    },
    meta: { leaseId },
  });

  expect(response.ok, JSON.stringify(response)).toBe(false);
  expect(JSON.stringify(response)).toContain('LEASE_SESSION_MISMATCH');
});

test('a batch step that names another tenant is refused on a leased session and keeps earlier results', async () => {
  const { handler, leaseId } = leasedRouter();

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'batch',
    positionals: [],
    flags: {
      batchSteps: [
        { command: 'snapshot', positionals: [], flags: {} },
        { command: 'snapshot', positionals: [], flags: { tenant: 'tenant-b' } },
      ],
    },
    meta: { leaseId, tenantId: 'tenant-a' },
  });

  expect(response.ok, JSON.stringify(response)).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('UNAUTHORIZED');
  expect(response.error.details).toMatchObject({
    reason: 'LEASE_SESSION_MISMATCH',
    field: 'tenantId',
    step: 2,
  });
  expect(JSON.stringify(response.error.details)).toContain('partialResults');
});

test('a batch step tenant flag does not refuse a step on an unleased session', async () => {
  const { handler } = leasedRouter({ leased: false });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'batch',
    positionals: [],
    flags: {
      batchSteps: [{ command: 'snapshot', positionals: [], flags: { tenant: 'tenant-b' } }],
    },
    meta: { tenantId: 'tenant-a' },
  });

  expect(response.ok, JSON.stringify(response)).toBe(true);
});
