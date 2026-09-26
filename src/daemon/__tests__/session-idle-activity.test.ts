/**
 * #2833: the request path reports session activity by finishing UNDER the session's execution lock —
 * the same lock an expiry must take before settling. That is what makes the stamp and the verdict
 * one clock: a session in use is never caught mid-command, and the deadline an expiry reads is the
 * one the last finished command set. Commands that never take that lock (the registry's
 * lock-exempt inventory surface) report nothing, so a bystander polling `devices` on a shared host
 * cannot keep another agent's abandoned claim alive; and a request whose client hung up preserves
 * nothing, exactly as a canceled request renews no lease (ADR 0007).
 */
import { afterAll, test, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { withDiagnosticsScope } from '@agent-device/host-kit/diagnostics';
import { clearRequestCanceled, markRequestCanceled } from '@agent-device/host-kit/request';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import {
  existingSessionExecutionLockKeys,
  resolveRequestExecutionLockPlan,
} from '../request-binding.ts';
import {
  createRequestExecutionScope,
  getLeaseRegistryExecutionLocks,
} from '../request-execution-scope.ts';
import { withKeyedLock } from '@agent-device/kernel/keyed-lock';
import type { DaemonRequest } from '../daemon-request.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

const TEST_ROOT = mkdtempForTestSync('agent-device-session-idle-activity-');
const LOG_PATH = path.join(TEST_ROOT, 'diagnostics.log');

afterAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function makeRequest(overrides: Partial<DaemonRequest> = {}): DaemonRequest {
  return {
    token: 'test-token',
    session: 'default',
    command: 'snapshot',
    positionals: [],
    ...overrides,
  };
}

function storeWithSession() {
  const sessionStore = makeSessionStore('agent-device-idle-activity-');
  sessionStore.set('default', makeIosSession('default'));
  return sessionStore;
}

test('a command that completes under the session lock stamps the session it ran on', async () => {
  const sessionStore = storeWithSession();
  const scope = await withDiagnosticsScope({ command: 'snapshot', logPath: LOG_PATH }, () =>
    createRequestExecutionScope({
      req: makeRequest({ command: 'snapshot' }),
      sessionStore,
      leaseRegistry: new LeaseRegistry(),
    }),
  );

  await scope.runLocked(async () => 'ran');

  expect(sessionStore.get('default')?.lastActivityAtMs).toBeGreaterThan(0);
});

test('a lock-exempt inventory command reports no activity, even against a claim-holding session', async () => {
  const sessionStore = storeWithSession();
  const scope = await withDiagnosticsScope({ command: 'devices', logPath: LOG_PATH }, () =>
    createRequestExecutionScope({
      req: makeRequest({ command: 'devices' }),
      sessionStore,
      leaseRegistry: new LeaseRegistry(),
    }),
  );

  await scope.runLocked(async () => 'ran');

  // `devices` resolves a session address only to locate its own artifacts. On the shared host this
  // feature exists for, stamping there would let one agent's polling extend another's deadline.
  expect(sessionStore.get('default')?.lastActivityAtMs).toBeUndefined();
});

test('a command whose client hung up mid-flight preserves no activity', async () => {
  const sessionStore = storeWithSession();
  const requestId = 'canceled-mid-command';
  const scope = await withDiagnosticsScope(
    { command: 'snapshot', requestId, logPath: LOG_PATH },
    () =>
      createRequestExecutionScope({
        req: makeRequest({ command: 'snapshot', meta: { requestId } }),
        sessionStore,
        leaseRegistry: new LeaseRegistry(),
      }),
  );

  // The request was admitted, then the client hung up while the handler worked. A handler that
  // ignores its cancellation still reaches the stamp site — and must not renew anything there, the
  // same rule that stops a canceled request renewing a remote lease (ADR 0007). An agent that
  // timed out and left a hung handler is precisely what this deadline exists to catch.
  try {
    await scope.runLocked(async () => {
      markRequestCanceled(requestId);
      return 'ran to completion despite the disconnect';
    });
    expect(sessionStore.get('default')?.lastActivityAtMs).toBeUndefined();
  } finally {
    clearRequestCanceled(requestId);
  }
});

test('a command still running when the expiry arrives blocks it until the stamp lands', async () => {
  const sessionStore = storeWithSession();
  const leaseRegistry = new LeaseRegistry();
  const locks = getLeaseRegistryExecutionLocks(leaseRegistry);
  const scope = await withDiagnosticsScope({ command: 'snapshot', logPath: LOG_PATH }, () =>
    createRequestExecutionScope({
      req: makeRequest({ command: 'snapshot' }),
      sessionStore,
      leaseRegistry,
    }),
  );

  let release!: () => void;
  const running = new Promise<void>((resolve) => {
    release = resolve;
  });
  const command = scope.runLocked(async () => {
    await running;
    return 'ran';
  });

  // An expiry that starts while the command holds the lock cannot settle — and once the command
  // finishes, its stamp is already visible to whoever finally holds the lock.
  let settledFirst = true;
  const expiry = withKeyedLock(locks, 'session:default', async () => {
    settledFirst = sessionStore.get('default')?.lastActivityAtMs === undefined;
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  release();
  await Promise.all([command, expiry]);

  expect(settledFirst).toBe(false);
});

test('the request plan for an existing session keeps the canonical session-first lock pair', async () => {
  const sessionStore = storeWithSession();
  const session = sessionStore.get('default')!;
  const requestPlan = await resolveRequestExecutionLockPlan({
    req: makeRequest({ command: 'snapshot' }),
    sessionName: 'default',
    sessionStore,
  });

  // What this pins is the PLANNER: an existing session's request takes `existingSessionExecutionLockKeys`
  // with the session first, which is the order a reaper must match to avoid deadlocking against it. The
  // reaper's own pair is exercised against a live request in server/daemon-session-idle-expiry.test.ts;
  // comparing this function with itself would prove nothing about that side.
  expect(requestPlan.keys).toEqual(existingSessionExecutionLockKeys('default', session.device.id));
});

test('the reaper never observes a mid-command session through the shared map', async () => {
  const sessionStore = storeWithSession();
  const leaseRegistry = new LeaseRegistry();
  const scope = await withDiagnosticsScope({ command: 'snapshot', logPath: LOG_PATH }, () =>
    createRequestExecutionScope({
      req: makeRequest({ command: 'snapshot' }),
      sessionStore,
      leaseRegistry,
    }),
  );

  const inside = vi.fn();
  await scope.runLocked(async () => {
    inside(getLeaseRegistryExecutionLocks(leaseRegistry).has('session:default'));
    return 'ran';
  });

  expect(inside).toHaveBeenCalledWith(true);
  expect(getLeaseRegistryExecutionLocks(leaseRegistry).has('session:default')).toBe(false);
});
