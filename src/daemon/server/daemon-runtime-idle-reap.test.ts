import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, test, vi } from 'vitest';

const leaseProbe = vi.hoisted(() => ({
  registries: [] as import('../lease-registry.ts').LeaseRegistry[],
}));
vi.mock('../lease-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lease-registry.ts')>();
  class RecordedLeaseRegistry extends actual.LeaseRegistry {
    constructor(...args: ConstructorParameters<typeof actual.LeaseRegistry>) {
      super(...args);
      leaseProbe.registries.push(this);
    }
  }
  return { ...actual, LeaseRegistry: RecordedLeaseRegistry };
});

import { resolveDaemonPaths } from '../../daemon-resolution.ts';
import { startDaemonRuntime } from './daemon-runtime.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

afterEach(() => {
  vi.useRealTimers();
  leaseProbe.registries.length = 0;
});

test('daemon runtime self-reaps after the idle window when nothing ever uses it', async () => {
  vi.useFakeTimers();
  const stateDir = mkdtempForTestSync('agent-device-daemon-idle-reap-rt-');
  const paths = resolveDaemonPaths(stateDir);
  let exitCode: number | undefined;
  let resolveExit: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  try {
    const runtime = await startDaemonRuntime({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '80',
      },
      exit: (code) => {
        exitCode = code;
        resolveExit();
      },
      registerProcessHandlers: false,
      stderr: { write: () => {} },
      stdout: { write: () => {} },
    });
    assert.notEqual(runtime, null);
    assert.ok(fs.existsSync(paths.lockPath), 'daemon lock should be held right after startup');
    assert.equal(exitCode, undefined);

    await vi.advanceTimersByTimeAsync(79);
    assert.equal(exitCode, undefined);
    await vi.advanceTimersByTimeAsync(1);
    await vi.runOnlyPendingTimersAsync();
    await exited;

    assert.equal(exitCode, 0);
    assert.equal(fs.existsSync(paths.infoPath), false);
    assert.equal(fs.existsSync(paths.lockPath), false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('daemon runtime never self-reaps when AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS is 0', async () => {
  vi.useFakeTimers();
  const stateDir = mkdtempForTestSync('agent-device-daemon-idle-reap-off-');
  let exitCode: number | undefined;

  try {
    const runtime = await startDaemonRuntime({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
      },
      exit: (code) => {
        exitCode = code;
      },
      registerProcessHandlers: false,
      stderr: { write: () => {} },
      stdout: { write: () => {} },
    });
    assert.notEqual(runtime, null);

    await vi.advanceTimersByTimeAsync(200);
    assert.equal(exitCode, undefined);
    const shutdownPromise = runtime?.shutdown();
    await vi.runOnlyPendingTimersAsync();
    await shutdownPromise;
    assert.equal(exitCode, 0);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('only a retained lease keeps the daemon runtime from self-reaping', async () => {
  vi.useFakeTimers();
  const stateDir = mkdtempForTestSync('agent-device-daemon-idle-reap-leases-');
  let exitCode: number | undefined;
  let resolveExit: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  try {
    const runtime = await startDaemonRuntime({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '80',
      },
      exit: (code) => {
        exitCode = code;
        resolveExit();
      },
      registerProcessHandlers: false,
      stderr: { write: () => {} },
      stdout: { write: () => {} },
    });
    assert.notEqual(runtime, null);
    const [registry] = leaseProbe.registries;
    registry!.allocateLease({ tenantId: 'tenant-a', runId: 'run-plain', ttlMs: 60_000 });
    const retained = registry!.allocateLease({
      tenantId: 'tenant-a',
      runId: 'run-retained',
      ttlMs: 60_000,
      retainOnClose: true,
    });

    await vi.advanceTimersByTimeAsync(80);
    assert.equal(exitCode, undefined);

    registry!.releaseLease({ leaseId: retained.leaseId });
    await vi.advanceTimersByTimeAsync(80);
    await vi.runOnlyPendingTimersAsync();
    await exited;
    assert.equal(exitCode, 0);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
