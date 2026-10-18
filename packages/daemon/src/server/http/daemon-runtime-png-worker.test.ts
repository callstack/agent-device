import fs from 'node:fs';
import { expect, test, vi } from 'vitest';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { daemonRuntimeDepsFixture } from '../../__tests__/support/daemon-runtime-deps-fixture.ts';
import { startDaemonRuntime } from './daemon-runtime.ts';

vi.mock('node:worker_threads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:worker_threads')>()),
  Worker: class {
    constructor() {
      throw new Error('worker threads are not available');
    }
  },
}));

test('a daemon whose PNG worker cannot start records the reason in daemon.log', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-png-worker-');
  let runtime: Awaited<ReturnType<typeof startDaemonRuntime>> = null;
  try {
    runtime = await startDaemonRuntime({
      host: createTestHostEnvironment({
        env: {
          AGENT_DEVICE_STATE_DIR: stateDir,
          AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
          AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
        },
      }),
      exit: () => {},
      registerProcessHandlers: false,
      stderr: { write: () => {} },
      stdout: { write: () => {} },
      composeDeps: daemonRuntimeDepsFixture({}),
    });
    expect(runtime).not.toBeNull();

    const events = fs
      .readFileSync(resolveDaemonPaths(stateDir).logPath, 'utf8')
      .split('\n')
      .filter((line) => line.includes('png_worker_unavailable'));
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('failed to spawn worker: worker threads are not available');
  } finally {
    await runtime?.shutdown();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
