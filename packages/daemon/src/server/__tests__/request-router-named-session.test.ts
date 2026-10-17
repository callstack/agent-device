import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { test, expect } from 'vitest';
import path from 'node:path';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import {
  createLifecycleDeviceRuntimeGatewaySpies,
  createRequestHandler,
  lifecycleDeviceRuntimeGateway,
} from '../../__tests__/support/test-device-runtime-gateway.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import type { DeviceRuntimeGateway } from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
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

function makeHandler(
  listings: { count: number },
  deviceRuntimeGateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = lifecycleDeviceRuntimeGateway,
) {
  const sessionStore = makeSessionStore('agent-device-router-named-session-');
  const handler = createRequestHandler({
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway,
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

test('a required-session command naming a missing session gets the typed refusal, not the generic one', async () => {
  // `get` requires a session, so its seam used to answer any missing session with the generic
  // "no active session" error before the provenance check could run. A caller that *named* the
  // session still deserves to learn which address is gone — the same event, the same typed reason.
  const listings = { count: 0 };
  const { handler } = makeHandler(listings);

  const response = await handler(request({ command: 'get', positionals: ['text', '@ref-1'] }));

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('SESSION_NOT_FOUND');
  expect(response.error.details?.reason).toBe(PRE_DISPATCH_REFUSAL_REASONS.namedSessionNotFound);
  expect(response.error.details?.session).toBe(LOST_SESSION);
  expect(listings.count).toBe(0);
});

test('a record start naming a missing session answers on the session, not on app scope', async () => {
  // `record start` defaults to app scope and used to answer a missing session with the
  // app-session INVALID_ARGS refusal. When the session itself is gone, the session is the first
  // cause, and the typed named-session refusal wins over the record-specific one.
  const listings = { count: 0 };
  const { handler } = makeHandler(listings);

  const response = await handler(request({ command: 'record', positionals: ['start'] }));

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('SESSION_NOT_FOUND');
  expect(response.error.details?.reason).toBe(PRE_DISPATCH_REFUSAL_REASONS.namedSessionNotFound);
  expect(response.error.details?.session).toBe(LOST_SESSION);
  expect(listings.count).toBe(0);
});

test('a record stop naming a missing session answers on the session, not on a host sweep', async () => {
  // The daemon-restart recovery (#3674): the durable manifest is the only thing that can answer
  // this stop, and the manifest is addressed by the session — so with two booted devices the
  // answer is still the typed session refusal or the manifest's own verdict, never the
  // AMBIGUOUS_MATCH an unconstrained sweep of this inventory would answer.
  const listings = { count: 0 };
  const { handler } = makeHandler(listings);

  const response = await handler(request({ command: 'record', positionals: ['stop'] }));

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('SESSION_NOT_FOUND');
  expect(response.error.details?.reason).toBe(PRE_DISPATCH_REFUSAL_REASONS.namedSessionNotFound);
  expect(response.error.details?.session).toBe(LOST_SESSION);
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
  // outright. Then the session is not what is missing and the refusal must stay out of the way —
  // proven by the runtime gateway actually binding the named simulator, not by the absence of a
  // particular error code (AMBIGUOUS_MATCH would satisfy a weaker assertion).
  const listings = { count: 0 };
  const { gateway, inspectFacts } = createLifecycleDeviceRuntimeGatewaySpies();
  const { handler } = makeHandler(listings, gateway);

  const response = await handler(request({ flags: { platform: 'ios', udid: 'SIM-A' } }));

  // Positive proof, not an absence: the runtime lane inspected SIM-A (and never SIM-B), so the
  // request's stated target won. Any refusal after that point is the device's own — here the
  // iOS app-session rule — and never the named-session one the missing session would answer.
  const inspectedDeviceIds = inspectFacts.mock.calls.map(([call]) => call.id);
  expect(inspectedDeviceIds).toContain('SIM-A');
  expect(inspectedDeviceIds).not.toContain('SIM-B');
  if (!response.ok) {
    expect(response.error.details?.reason).not.toBe(
      PRE_DISPATCH_REFUSAL_REASONS.namedSessionNotFound,
    );
  }
  expect(listings.count).toBeGreaterThan(0);
});

test('a sessionless close naming a missing session answers on the session', async () => {
  // The close fall-through is the sibling of the snapshot one: it names the missing session with
  // the same typed refusal and resolves no device at all. The generic SESSION_NOT_FOUND the
  // sessionless close used to answer must not satisfy this.
  const listings = { count: 0 };
  const { handler } = makeHandler(listings);

  const response = await handler(request({ command: 'close', positionals: ['com.example.app'] }));

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('SESSION_NOT_FOUND');
  expect(response.error.message).toContain(`No active session "${LOST_SESSION}"`);
  expect(response.error.details?.reason).toBe(PRE_DISPATCH_REFUSAL_REASONS.namedSessionNotFound);
  expect(response.error.details?.dispatched).toBe('no');
  expect(response.error.details?.session).toBe(LOST_SESSION);
  expect(listings.count).toBe(0);
});
