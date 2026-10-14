import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, test, vi } from 'vitest';

const leaseProbe = vi.hoisted(() => ({
  registries: [] as import('@agent-device/daemon/testing/lease-registry').LeaseRegistry[],
  ended: [] as Array<[string, string]>,
}));
vi.mock('@agent-device/daemon/testing/lease-registry', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/daemon/testing/lease-registry')>();
  class RecordedLeaseRegistry extends actual.LeaseRegistry {
    constructor(...args: ConstructorParameters<typeof actual.LeaseRegistry>) {
      super(...args);
      leaseProbe.registries.push(this);
    }
  }
  return { ...actual, LeaseRegistry: RecordedLeaseRegistry };
});
vi.mock('@agent-device/daemon/testing/server/daemon-lease-session-end', () => ({
  createLeaseSessionEnd: () => ({
    end: async (leaseId: string, reason: string) => {
      leaseProbe.ended.push([leaseId, reason]);
    },
    cancel: () => {},
    drain: async () => {},
  }),
}));

import { startDaemonRuntimeFixture } from '../daemon-runtime-fixture.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';

afterEach(() => {
  vi.useRealTimers();
  leaseProbe.registries.length = 0;
  leaseProbe.ended.length = 0;
});

test('an expired lease ends its session without any further request', async () => {
  vi.useFakeTimers();
  const stateDir = mkdtempForTestSync('agent-device-daemon-lease-expiry-');
  try {
    const runtime = await startDaemonRuntimeFixture({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
        AGENT_DEVICE_LEASE_MIN_TTL_MS: '1',
      },
      exit: () => {},
      registerProcessHandlers: false,
      stderr: { write: () => {} },
      stdout: { write: () => {} },
    });
    assert.notEqual(runtime, null);
    const [registry] = leaseProbe.registries;
    const lease = registry!.allocateLease({ tenantId: 'tenant-a', runId: 'run-1', ttlMs: 50 });

    await vi.advanceTimersByTimeAsync(40);
    assert.deepEqual(leaseProbe.ended, []);

    await vi.advanceTimersByTimeAsync(1_000);
    assert.deepEqual(leaseProbe.ended, [[lease.leaseId, 'LEASE_EXPIRED']]);

    const shutdown = runtime?.shutdown();
    await vi.runOnlyPendingTimersAsync();
    await shutdown;
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
