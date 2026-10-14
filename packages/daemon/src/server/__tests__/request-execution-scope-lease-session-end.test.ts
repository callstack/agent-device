import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { authoringPublication, makeIosSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import {
  isolatedDeviceClaimStores,
  retainOrphanedDeviceClaims,
} from '../../__tests__/support/device-claim-store.ts';
import { acquireDeviceClaim } from '../../resources/device/device-claims.ts';
import { resolveDeviceClaimPath } from '../../resources/device/device-claim-paths.ts';
import { existingSessionExecutionLockKeys } from '../request-binding.ts';
import { withRequestExecutionLockKeys } from '../request-execution-locks.ts';
import type { SessionStore } from '../../core/session-store.ts';
import type { SessionTeardown } from '../../sessions/lease-lifecycle.ts';
import { createLeaseSessionEnd } from '../request-execution-scope.ts';

vi.mock('@agent-device/host-kit/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/diagnostics')>();
  return { ...actual, emitDiagnostic: vi.fn() };
});

const claimStores = isolatedDeviceClaimStores('agent-device-lease-end-claims-');

async function publishLeasedSession(
  sessionStore: SessionStore,
  name: string,
  leaseId: string,
): Promise<string> {
  const { stateDir } = claimStores();
  const session = makeIosSession(name, {
    lease: { leaseId, tenantId: 'tenant-a', runId: 'run-1' },
  });
  const acquired = await acquireDeviceClaim({
    device: session.device,
    session: name,
    workspace: stateDir,
    stateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });
  if (acquired.status !== 'acquired') throw new Error('expected an acquired claim');
  sessionStore.publish(name, { ...session, deviceClaim: acquired.ownership });
  return resolveDeviceClaimPath(acquired.ownership.deviceKey);
}

function holdSessionLocks(
  executionLocks: Map<string, Promise<unknown>>,
  sessionStore: SessionStore,
  name: string,
): { finish: () => void; held: Promise<void> } {
  let finish!: () => void;
  const running = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const held = withRequestExecutionLockKeys(
    executionLocks,
    existingSessionExecutionLockKeys(name, sessionStore.get(name)!.device.id),
    async () => await running,
  );
  return { finish, held };
}

function leaseSessionEnd(sessionStore: SessionStore, teardownSession: SessionTeardown) {
  const executionLocks = new Map<string, Promise<unknown>>();
  return {
    executionLocks,
    ender: createLeaseSessionEnd({ sessionStore, executionLocks, teardownSession }),
  };
}

const settle = async (): Promise<void> => await new Promise((resolve) => setImmediate(resolve));

test('end publishes the recorded script of the session it ends', async () => {
  const sessionStore = makeSessionStore('agent-device-lease-end-script-');
  await publishLeasedSession(sessionStore, 'leased', 'lease-1');
  const scriptPath = path.join(mkdtempForTestSync('agent-device-lease-end-ad-'), 'flow.ad');
  sessionStore.update(sessionStore.lookup('leased')!, {
    scriptPublication: authoringPublication('armed', { path: scriptPath }),
    actions: [{ ts: 1, command: 'click', positionals: ['id="recorded-step"'], flags: {} }],
  });

  await leaseSessionEnd(sessionStore, async () => {}).ender.end('lease-1', 'LEASE_EXPIRED');

  expect(sessionStore.get('leased')).toBeUndefined();
  expect(fs.readFileSync(scriptPath, 'utf8')).toMatch(/recorded-step/);
});

test('end tears down the session opened under the lease and clears its device claim', async () => {
  const sessionStore = makeSessionStore('agent-device-lease-end-');
  const claimPath = await publishLeasedSession(sessionStore, 'leased', 'lease-1');
  sessionStore.publish(
    'other',
    makeIosSession('other', {
      lease: { leaseId: 'lease-2', tenantId: 'tenant-b', runId: 'run-2' },
    }),
  );
  expect(fs.existsSync(claimPath)).toBe(true);
  const teardownSession = vi.fn(async () => {});

  await leaseSessionEnd(sessionStore, teardownSession).ender.end('lease-1', 'LEASE_RELEASED');

  expect(teardownSession).toHaveBeenCalledTimes(1);
  expect(teardownSession).toHaveBeenCalledWith(expect.objectContaining({ address: 'leased' }));
  expect(sessionStore.get('leased')).toBeUndefined();
  expect(fs.existsSync(claimPath)).toBe(false);
  expect(sessionStore.get('other')).toBeDefined();
});

test('end clears the claim of a session whose device no longer answers', async () => {
  const sessionStore = makeSessionStore('agent-device-lease-end-unreachable-');
  const claimPath = await publishLeasedSession(sessionStore, 'leased', 'lease-1');

  await leaseSessionEnd(sessionStore, async () => {
    throw new Error('device unreachable');
  }).ender.end('lease-1', 'LEASE_EXPIRED');

  expect(sessionStore.get('leased')).toBeUndefined();
  expect(fs.existsSync(claimPath)).toBe(false);
});

test('end waits for the command still holding the session execution locks', async () => {
  const sessionStore = makeSessionStore('agent-device-lease-end-locked-');
  await publishLeasedSession(sessionStore, 'leased', 'lease-1');
  const teardownSession = vi.fn(async () => {});
  const { executionLocks, ender } = leaseSessionEnd(sessionStore, teardownSession);
  const command = holdSessionLocks(executionLocks, sessionStore, 'leased');

  const ending = ender.end('lease-1', 'LEASE_RELEASED');
  await settle();
  expect(teardownSession).not.toHaveBeenCalled();
  expect(sessionStore.get('leased')).toBeDefined();

  command.finish();
  await command.held;
  await ending;
  expect(teardownSession).toHaveBeenCalledTimes(1);
  expect(sessionStore.get('leased')).toBeUndefined();
});

test('cancel stops a lease end still queued on the session locks from tearing down', async () => {
  const sessionStore = makeSessionStore('agent-device-lease-end-cancel-');
  const claimPath = await publishLeasedSession(sessionStore, 'leased', 'lease-1');
  const teardownSession = vi.fn(async () => {});
  const { executionLocks, ender } = leaseSessionEnd(sessionStore, teardownSession);
  const command = holdSessionLocks(executionLocks, sessionStore, 'leased');

  const ending = ender.end('lease-1', 'LEASE_EXPIRED');
  await settle();
  ender.cancel();
  command.finish();
  await command.held;
  await ending;

  expect(teardownSession).not.toHaveBeenCalled();
  expect(sessionStore.get('leased')).toBeDefined();
  expect(fs.existsSync(claimPath)).toBe(true);
  await ender.end('lease-1', 'LEASE_RELEASED');
  expect(teardownSession).not.toHaveBeenCalled();
});

test('drain waits for a lease end whose teardown is already running', async () => {
  const sessionStore = makeSessionStore('agent-device-lease-end-drain-');
  await publishLeasedSession(sessionStore, 'leased', 'lease-1');
  let finishTeardown!: () => void;
  const teardownStarted = vi.fn();
  const { ender } = leaseSessionEnd(sessionStore, async () => {
    teardownStarted();
    await new Promise<void>((resolve) => {
      finishTeardown = resolve;
    });
  });

  void ender.end('lease-1', 'LEASE_EXPIRED');
  await settle();
  expect(teardownStarted).toHaveBeenCalledTimes(1);
  ender.cancel();
  let drained = false;
  const drain = ender.drain().then(() => {
    drained = true;
  });
  await settle();
  expect(drained).toBe(false);

  finishTeardown();
  await drain;
  expect(sessionStore.get('leased')).toBeUndefined();
});
