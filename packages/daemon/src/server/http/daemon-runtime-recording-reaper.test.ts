import fs from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';

const reapCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('@agent-device/host-kit/process', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    reapOwnedProcessRecordsAtStartup: (_store: unknown, options?: Record<string, unknown>) => {
      reapCalls.push(options ?? {});
      return Promise.resolve({ terminated: [], failed: [] });
    },
  };
});

import { daemonRuntimeDepsFixture } from '../../__tests__/support/daemon-runtime-deps-fixture.ts';
import { startDaemonRuntime } from './daemon-runtime.ts';

afterEach(() => {
  reapCalls.length = 0;
});

test('daemon startup reaps orphaned simctl recorders with a graceful finalize window', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-recording-reaper-');
  try {
    const runtime = await startDaemonRuntime({
      composeDeps: daemonRuntimeDepsFixture(),
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
      },
      exit: () => {},
      registerProcessHandlers: false,
      stderr: { write: () => {} },
      stdout: { write: () => {} },
    });
    expect(runtime).not.toBeNull();

    const recordingReap = reapCalls.find(
      (call) => JSON.stringify(call.purposes) === JSON.stringify(['simctl-screen-recording']),
    );
    expect(recordingReap, 'startup should reap the simctl recorder purpose').toBeDefined();
    // An orphaned recorder must get the same graceful finalize window the live stop path allows,
    // so it releases the host recording lock instead of leaving it dangling for the next session.
    expect(Number(recordingReap!.termTimeoutMs)).toBeGreaterThanOrEqual(5_000);

    await runtime?.shutdown();
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
