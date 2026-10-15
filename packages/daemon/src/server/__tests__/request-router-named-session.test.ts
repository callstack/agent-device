import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { test, expect } from 'vitest';
import path from 'node:path';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import {
  createRequestHandler,
  lifecycleDeviceRuntimeGateway,
} from '../../__tests__/support/test-device-runtime-gateway.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { PRE_DISPATCH_REFUSAL_REASONS } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '@agent-device/test-kit';

// #3674: a run whose daemon was replaced mid-test keeps sending commands to the session it opened.
// The answer has to name the session that went missing, and must not depend on how many devices
// happen to be booted on the host.

const LOST_SESSION = 'e2e-ios-0';

function bootedSimulator(id: string, name: string): DeviceInfo {
  return {
    platform: 'apple',
    target: 'mobile',
    id,
    name,
    kind: 'simulator',
    booted: true,
  };
}

const BOOTED_SIMULATORS: DeviceInfo[] = [
  bootedSimulator('SIM-A', 'TinyConcepts E2E'),
  bootedSimulator('SIM-B', 'Perf iPhone 17'),
];

function makeHandler(listings: { count: number }) {
  const sessionStore = makeSessionStore('agent-device-router-named-session-');
  const handler = createRequestHandler({
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways({
      local: async () => {
        listings.count += 1;
        return BOOTED_SIMULATORS;
      },
    }),
    trackDownloadableArtifact: () => 'artifact-id',
  });
  return { handler, sessionStore };
}

function request(overrides: Partial<DaemonRequest> = {}): DaemonRequest {
  return {
    token: 'test-token',
    session: LOST_SESSION,
    command: 'snapshot',
    positionals: [],
    flags: {},
    meta: { requestId: 'named-session-request', sessionExplicit: true },
    ...overrides,
  };
}

test('a command naming a session this daemon does not hold answers on the session, not the device', async () => {
  const { handler } = makeHandler({ count: 0 });

  const response = await handler(request());

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('SESSION_NOT_FOUND');
  expect(response.error.message).toContain(`No active session "${LOST_SESSION}"`);
  expect(response.error.details?.reason).toBe(PRE_DISPATCH_REFUSAL_REASONS.namedSessionNotFound);
  expect(response.error.details?.dispatched).toBe('no');
  expect(response.error.details?.session).toBe(LOST_SESSION);
});

test('the refusal answers without listing the host devices at all', async () => {
  const listings = { count: 0 };
  const { handler } = makeHandler(listings);

  await handler(request());

  expect(listings.count).toBe(0);
});

test('the same command with no session named still resolves a device sessionlessly', async () => {
  // The closest negative: same daemon, same two booted simulators, same command. What changes is
  // only whether the caller named a session, and that is what the answer must turn on.
  const listings = { count: 0 };
  const { handler } = makeHandler(listings);

  const response = await handler(
    request({ session: 'default', meta: { requestId: 'sessionless-request' } }),
  );

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('AMBIGUOUS_MATCH');
  expect(listings.count).toBeGreaterThan(0);
});

test('a named session beside a device selector keeps honouring the device it names', async () => {
  // The other closest negative: the same missing session, but the request states its target
  // outright. Then the session is not what is missing and the refusal must stay out of the way.
  const listings = { count: 0 };
  const { handler } = makeHandler(listings);

  const response = await handler(request({ flags: { platform: 'ios', udid: 'SIM-A' } }));

  if (!response.ok) {
    expect(response.error.details?.reason).not.toBe(
      PRE_DISPATCH_REFUSAL_REASONS.namedSessionNotFound,
    );
  }
  expect(listings.count).toBeGreaterThan(0);
});

test('a sessionless close naming a missing session answers on the session', async () => {
  const { handler } = makeHandler({ count: 0 });

  const response = await handler(request({ command: 'close', positionals: ['com.example.app'] }));

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('SESSION_NOT_FOUND');
  expect(response.error.message).toContain(`No active session "${LOST_SESSION}"`);
});
