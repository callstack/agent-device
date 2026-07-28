// Real-scope same-device serialization guard for the concurrency torture lane
// (#1416). The seeded sweep models the mutex GRANT (a seed cannot reproduce
// `withKeyedLock`'s native microtask hand-off), so on its own it could stay
// green if the PRODUCTION lock APPLICATION path regressed. This guard closes
// that gap by driving two concurrent requests for the SAME device through the
// real `createRequestExecutionScope().runLocked()` — i.e. the actual
// `withRequestExecutionLocks` → `withKeyedLock` machinery, not a model — and
// asserting their critical sections never overlap. It is intentionally NOT
// seeded: it exercises real event-loop scheduling. Disabling production locking
// (`shouldLockSessionExecution` → false, or dropping the `device:` key) makes
// two sections overlap and trips this assertion.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRequestExecutionScope } from '../../../../src/daemon/request-execution-scope.ts';
import { LeaseRegistry } from '../../../../src/daemon/lease-registry.ts';
import { SessionStore } from '../../../../src/daemon/session-store.ts';
import { withDeviceInventoryProvider } from '../../../../src/core/dispatch-resolve.ts';
import type { CommandFlags } from '../../../../src/core/dispatch-context.ts';
import type { DaemonRequest } from '../../../../src/daemon/types.ts';

import { DEVICE_POOL } from './bindings.ts';

function openRequest(sessionName: string, deviceId: string): DaemonRequest {
  return {
    command: 'open',
    positionals: [],
    token: 'torture',
    session: sessionName,
    flags: { platform: 'ios', udid: deviceId } as CommandFlags,
  } as DaemonRequest;
}

/**
 * Drive `concurrency` fresh opens of ONE device concurrently through the real
 * request execution scope and return the maximum number of critical sections
 * that were ever active at once. Production serialization ⇒ exactly 1.
 */
export async function measureRealScopeMaxOverlap(concurrency: number): Promise<number> {
  const device = DEVICE_POOL[0];
  assert.ok(device, 'DEVICE_POOL must not be empty');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torture-real-scope-'));
  const sessionStore = new SessionStore(dir);
  const leaseRegistry = new LeaseRegistry();

  let active = 0;
  let maxActive = 0;
  const criticalSection = async (): Promise<void> => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    // Yield across several event-loop turns so a NON-serializing lock would let
    // a second section observe `active > 1` here.
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
  };

  try {
    await withDeviceInventoryProvider(
      async () => [device],
      async () => {
        const scopes = await Promise.all(
          Array.from({ length: concurrency }, (_, i) =>
            createRequestExecutionScope({
              req: openRequest(`real-${i}`, device.id),
              sessionStore,
              leaseRegistry,
            }),
          ),
        );
        await Promise.all(scopes.map((scope) => scope.runLocked(criticalSection)));
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return maxActive;
}
