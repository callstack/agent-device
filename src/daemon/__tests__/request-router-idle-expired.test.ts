import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
/**
 * #2833: when a command finds no session because this daemon already expired it for idleness, the
 * answer stays `SESSION_NOT_FOUND` but carries the typed reason, the window it missed, and the device
 * it released — never a bare "Run open first" with nothing to reason about. The repair tombstone is
 * consulted first, so an abandoned repair transaction keeps its own, more specific guidance.
 */
import { test, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

import { createRequestHandler } from './test-device-runtime-gateway.ts';
import { buildIdleExpiryTombstone } from '../session-idle-expiry.ts';
import type { DaemonRequest } from '../daemon-request.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

function makeHandler(prefix: string) {
  const sessionStore = makeSessionStore(prefix);
  const handler = createRequestHandler({
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
  });
  return { sessionStore, handler };
}

function closeRequest(session: string, tenant?: string): DaemonRequest {
  return {
    token: 'test-token',
    session,
    command: 'close',
    positionals: [],
    flags: {},
    ...(tenant ? { meta: { tenantId: tenant, sessionIsolation: 'tenant' as const } } : {}),
  };
}

function writeIdleMarker(sessionStore: ReturnType<typeof makeSessionStore>, session: string) {
  sessionStore.writeIdleExpiryTombstone(
    session,
    buildIdleExpiryTombstone(session, {
      expiredAtMs: Date.now(),
      idleExpiryMs: 1_500_000,
      deviceKey: 'ios:sim-1',
    }),
  );
}

test('a command on an idle-expired session names the reason, window, and released device', async () => {
  const { sessionStore, handler } = makeHandler('agent-device-router-idle-expired-');
  writeIdleMarker(sessionStore, 'idle-x');

  const response = await handler(closeRequest('idle-x'));

  expect(response.ok).toBe(false);
  if (response.ok) return;
  // Still SESSION_NOT_FOUND: the session genuinely is gone. What changes is what it says why.
  expect(response.error.code).toBe('SESSION_NOT_FOUND');
  expect(response.error.details?.reason).toBe('SESSION_IDLE_EXPIRED');
  expect(response.error.details?.idleExpiryMs).toBe(1_500_000);
  expect(response.error.details?.deviceKey).toBe('ios:sim-1');
  expect(response.error.hint).toMatch(/ios:sim-1/);
});

test('an expired session with no marker keeps the plain SESSION_NOT_FOUND', async () => {
  const { handler } = makeHandler('agent-device-router-idle-no-marker-');
  const response = await handler(closeRequest('never-existed'));

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('SESSION_NOT_FOUND');
  expect(response.error.details?.reason).toBeUndefined();
});

test('an expired marker that has aged out stops explaining the absence', async () => {
  const { sessionStore, handler } = makeHandler('agent-device-router-idle-stale-');
  writeIdleMarker(sessionStore, 'idle-stale');
  const markerPath = path.join(sessionStore.resolveSessionDir('idle-stale'), 'idle-expiry.json');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { expiresAt: number };
  marker.expiresAt = Date.now() - 1;
  fs.writeFileSync(markerPath, `${JSON.stringify(marker)}\n`);

  const response = await handler(closeRequest('idle-stale'));

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('SESSION_NOT_FOUND');
  expect(response.error.details?.reason).toBeUndefined();
});

test('an abandoned repair transaction outranks the idle-expiry marker', async () => {
  const { sessionStore, handler } = makeHandler('agent-device-router-idle-vs-repair-');
  writeIdleMarker(sessionStore, 'repair-x');
  sessionStore.writeRepairTombstone({
    name: 'repair-x',
    device: { platform: 'apple', id: 'sim-1', name: 'iPhone', kind: 'simulator', booted: true },
    createdAt: Date.now(),
    actions: [],
    scriptPublication: {
      kind: 'repair',
      status: 'armed',
      target: { kind: 'default', force: false },
      boundary: 0,
      sourcePath: '/flows/login.ad',
    },
  });

  const response = await handler(closeRequest('repair-x'));

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('REPAIR_SESSION_EXPIRED');
});

test('a tenant-isolated request reads the marker for its own scoped session', async () => {
  const { sessionStore, handler } = makeHandler('agent-device-router-idle-tenant-');
  // The request names `idle-x` and the daemon owns it as `<tenant>:idle-x`. Reading the raw name
  // would miss the marker entirely and return a bare "Run open first".
  writeIdleMarker(sessionStore, 'tenant-a:idle-x');

  const response = await handler(closeRequest('idle-x', 'tenant-a'));

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('SESSION_NOT_FOUND');
  expect(response.error.details?.reason).toBe('SESSION_IDLE_EXPIRED');
  expect(response.error.details?.deviceKey).toBe('ios:sim-1');
});

test('another tenant marker never explains this tenant absent session', async () => {
  const { sessionStore, handler } = makeHandler('agent-device-router-idle-tenant-leak-');
  writeIdleMarker(sessionStore, 'tenant-b:idle-x');

  const response = await handler(closeRequest('idle-x', 'tenant-a'));

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('SESSION_NOT_FOUND');
  // Reading the unscoped key would have reported tenant-b's device as the one tenant-a just lost.
  expect(response.error.details?.reason).toBeUndefined();
  expect(response.error.details?.deviceKey).toBeUndefined();
});
