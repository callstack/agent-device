import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { supportsLoopbackBind } from '@agent-device/test-kit';
import {
  launchesFreshHttpDaemon,
  stateDirAndPaths,
} from '../../__tests__/test-utils/registered-http-daemon.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmdDetachedMonitored: vi.fn(),
}));
import { runCmdDetachedMonitored } from '@agent-device/host-kit/command';
import * as hostProcess from '@agent-device/host-kit/process';
import { createCommandToolExecutor } from '../command-tools.ts';

// An MCP tool call builds its own client, so each call has to ensure the daemon it is about to use
// and then attach to it. This drives the default client factory and the real daemon-client entry
// against a real registered child.

const spawn = vi.mocked(runCmdDetachedMonitored);
let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  spawn.mockReset();
  await close?.();
  close = undefined;
});

test('each MCP tool call ensures the daemon, then attaches to it', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback listeners are not permitted');
  const { stateDir, paths } = stateDirAndPaths();
  const daemon = await launchesFreshHttpDaemon(spawn, paths);
  close = daemon.close;
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', stateDir);
  const capture = vi.spyOn(hostProcess, 'captureHostEnvironment');
  const executor = createCommandToolExecutor();

  const first = await executor.execute('devices', {});
  const second = await executor.execute('devices', {});

  assert.equal(first.isError, false, JSON.stringify(first.structuredContent));
  assert.equal(second.isError, false, JSON.stringify(second.structuredContent));
  assert.equal(spawn.mock.calls.length, 1, 'the second call reuses the daemon the first started');
  assert.deepEqual(daemon.commands(), ['devices', 'devices']);
  assert.equal(capture.mock.calls.length, 2, 'one host capture per tool call');
});
