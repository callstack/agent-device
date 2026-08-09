import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
/**
 * `--actions` reads custom actions through the private-AX snapshot path, which
 * a raw capture does not use. Answering the pair with a capture that
 * structurally cannot carry actions would silently no-op a requested
 * capability, so it is rejected at the shared request seam — before any
 * session or device work, which is why no device setup is needed here.
 */
import { test, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { createRequestHandler } from '../request-router.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';

function createHandler() {
  return createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore: makeSessionStore('agent-device-router-custom-action-flags-'),
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
  });
}

test('--actions with --raw is rejected as INVALID_ARGS before any command runs', async () => {
  const response = await createHandler()({
    token: 'test-token',
    session: 'default',
    command: 'snapshot',
    positionals: [],
    flags: { snapshotCustomActions: true, snapshotRaw: true },
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('INVALID_ARGS');
  expect(response.error.message).toMatch(/--actions and --raw are mutually exclusive/);
});

test('--actions alone is not rejected by the pairing check', async () => {
  const response = await createHandler()({
    token: 'test-token',
    session: 'default',
    command: 'get',
    positionals: ['attrs', '@e1'],
    flags: { snapshotCustomActions: true },
  });

  // Fails downstream on the missing session — but not on the pair. (The guard
  // is flag-scoped, so any command exercises it; a ref get fails fast.)
  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.message).not.toMatch(/mutually exclusive/);
});

test('--raw alone is untouched by the guard', async () => {
  const response = await createHandler()({
    token: 'test-token',
    session: 'default',
    command: 'get',
    positionals: ['attrs', '@e1'],
    flags: { snapshotRaw: true },
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.message).not.toMatch(/mutually exclusive/);
});
