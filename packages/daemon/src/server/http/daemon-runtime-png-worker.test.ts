import type { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { expect, test, vi } from 'vitest';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { daemonRuntimeDepsFixture } from '../../__tests__/support/daemon-runtime-deps-fixture.ts';

const workers = vi.hoisted(() => ({
  spawn: 'start' as 'start' | 'throw',
  last: undefined as unknown,
}));
vi.mock('node:worker_threads', async (importOriginal) => {
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    ...(await importOriginal<typeof import('node:worker_threads')>()),
    Worker: class extends Emitter {
      constructor() {
        super();
        if (workers.spawn === 'throw') throw new Error('worker threads are not available');
        workers.last = this;
      }
      postMessage(): void {}
      ref(): void {}
      unref(): void {}
      terminate(): Promise<number> {
        return Promise.resolve(0);
      }
    },
  };
});

async function pngWorkerEventsAfter(spawn: 'start' | 'throw', act: () => void): Promise<string[]> {
  workers.spawn = spawn;
  // The worker client keeps its state per module instance, so each daemon gets a fresh one.
  vi.resetModules();
  const { startDaemonRuntime } = await import('./daemon-runtime.ts');
  const stateDir = mkdtempForTestSync('agent-device-daemon-png-worker-');
  let runtime: Awaited<ReturnType<typeof startDaemonRuntime>> | null = null;
  try {
    runtime = await startDaemonRuntime({
      host: createTestHostEnvironment({
        env: {
          AGENT_DEVICE_STATE_DIR: stateDir,
          AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
          AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
        },
      }),
      stderr: { write: () => {} },
      stdout: { write: () => {} },
      composeDeps: daemonRuntimeDepsFixture({}),
    });
    expect(runtime).not.toBeNull();
    act();
    const { logPath } = resolveDaemonPaths(stateDir);
    const readEvents = () =>
      fs
        .readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((line) => line.includes('png_worker_unavailable'));
    await vi.waitFor(() => expect(readEvents().length).toBeGreaterThan(0));
    // A second report would arrive on the same turn as the first; let it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return readEvents();
  } finally {
    await runtime?.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

test('a daemon whose PNG worker cannot start records the reason in daemon.log once', async () => {
  const events = await pngWorkerEventsAfter('throw', () => {});

  expect(events).toHaveLength(1);
  expect(events[0]).toContain('spawn-failed');
  expect(events[0]).toContain('worker threads are not available');
});

test('a worker that fails after it started is recorded in daemon.log once, outside any request', async () => {
  const events = await pngWorkerEventsAfter('start', () => {
    const worker = workers.last as EventEmitter;
    worker.emit('error', new Error('worker crashed'));
    worker.emit('exit', 1);
  });

  expect(events).toHaveLength(1);
  expect(events[0]).toContain('worker-error');
  expect(events[0]).toContain('worker crashed');
});
