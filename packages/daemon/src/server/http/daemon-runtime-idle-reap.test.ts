import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, test, vi } from 'vitest';

const leaseProbe = vi.hoisted(() => ({
  registries: [] as import('../../resources/lease-registry.ts').LeaseRegistry[],
}));
vi.mock('../../resources/lease-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../resources/lease-registry.ts')>();
  class RecordedLeaseRegistry extends actual.LeaseRegistry {
    constructor(...args: ConstructorParameters<typeof actual.LeaseRegistry>) {
      super(...args);
      leaseProbe.registries.push(this);
    }
  }
  return { ...actual, LeaseRegistry: RecordedLeaseRegistry };
});

import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { daemonRuntimeDepsFixture } from '../../__tests__/support/daemon-runtime-deps-fixture.ts';
import { startDaemonRuntime } from './daemon-runtime.ts';
import { mkdtempForTestSync, createTestHostEnvironment } from '@agent-device/test-kit';

afterEach(() => {
  vi.useRealTimers();
  leaseProbe.registries.length = 0;
});

test('daemon runtime self-reaps after the idle window when nothing ever uses it', async () => {
  vi.useFakeTimers();
  const stateDir = mkdtempForTestSync('agent-device-daemon-idle-reap-rt-');
  const paths = resolveDaemonPaths(stateDir);
  let closed = false;

  try {
    const runtime = await startDaemonRuntime({
      composeDeps: daemonRuntimeDepsFixture(),
      host: createTestHostEnvironment({
        env: {
          ...process.env,
          AGENT_DEVICE_STATE_DIR: stateDir,
          AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
          AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '80',
        },
      }),
      stderr: { write: () => {} },
      stdout: { write: () => {} },
    });
    const exited = runtime.closed.then(() => {
      closed = true;
    });
    assert.ok(fs.existsSync(paths.lockPath), 'daemon lock should be held right after startup');
    assert.equal(closed, false);

    await vi.advanceTimersByTimeAsync(79);
    assert.equal(closed, false);
    await vi.advanceTimersByTimeAsync(1);
    await vi.runOnlyPendingTimersAsync();
    await exited;

    assert.equal(closed, true);
    assert.equal(fs.existsSync(paths.infoPath), false);
    assert.equal(fs.existsSync(paths.lockPath), false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('daemon runtime never self-reaps when AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS is 0', async () => {
  vi.useFakeTimers();
  const stateDir = mkdtempForTestSync('agent-device-daemon-idle-reap-off-');
  let closed = false;

  try {
    const runtime = await startDaemonRuntime({
      composeDeps: daemonRuntimeDepsFixture(),
      host: createTestHostEnvironment({
        env: {
          ...process.env,
          AGENT_DEVICE_STATE_DIR: stateDir,
          AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
          AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
        },
      }),
      stderr: { write: () => {} },
      stdout: { write: () => {} },
    });
    const exited = runtime.closed.then(() => {
      closed = true;
    });

    await vi.advanceTimersByTimeAsync(200);
    assert.equal(closed, false);
    const shutdownPromise = runtime.close();
    await vi.runOnlyPendingTimersAsync();
    await shutdownPromise;
    await exited;
    assert.equal(closed, true);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('only a retained lease keeps the daemon runtime from self-reaping', async () => {
  vi.useFakeTimers();
  const stateDir = mkdtempForTestSync('agent-device-daemon-idle-reap-leases-');
  let closed = false;

  try {
    const runtime = await startDaemonRuntime({
      composeDeps: daemonRuntimeDepsFixture(),
      host: createTestHostEnvironment({
        env: {
          ...process.env,
          AGENT_DEVICE_STATE_DIR: stateDir,
          AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
          AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '80',
        },
      }),
      stderr: { write: () => {} },
      stdout: { write: () => {} },
    });
    const exited = runtime.closed.then(() => {
      closed = true;
    });
    const [registry] = leaseProbe.registries;
    registry!.allocateLease({ tenantId: 'tenant-a', runId: 'run-plain', ttlMs: 60_000 });
    const retained = registry!.allocateLease({
      tenantId: 'tenant-a',
      runId: 'run-retained',
      ttlMs: 60_000,
      retainOnClose: true,
    });

    await vi.advanceTimersByTimeAsync(80);
    assert.equal(closed, false);

    registry!.releaseLease({ leaseId: retained.leaseId });
    await vi.advanceTimersByTimeAsync(80);
    await vi.runOnlyPendingTimersAsync();
    await exited;
    assert.equal(closed, true);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
