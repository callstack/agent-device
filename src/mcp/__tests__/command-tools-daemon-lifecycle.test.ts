import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { closeLoopbackServer, supportsLoopbackBind } from '@agent-device/test-kit';
import { finishRegisteredDaemonFixtures } from '../../__tests__/test-utils/registered-daemon-fixture.ts';
import {
  launchesFreshDaemonAt,
  okResult,
  startScriptedDaemon,
  stateDirAndPaths,
} from '../../daemon-client/__tests__/explicit-lifecycle-fixture.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmdDetachedMonitored: vi.fn(),
}));
import { runCmdDetachedMonitored } from '@agent-device/host-kit/command';
import * as hostProcess from '@agent-device/host-kit/process';
import * as ensureModule from '../../daemon-client/daemon-client-ensure.ts';
import { createCommandToolExecutor } from '../command-tools.ts';

// An MCP tool call builds its own client, so each call has to ensure the daemon it is about to use
// and then attach to it. This drives the default client factory, not an injected one.

const spawn = vi.mocked(runCmdDetachedMonitored);

afterEach(async () => {
  vi.unstubAllEnvs();
  spawn.mockReset();
  await finishRegisteredDaemonFixtures();
});

test('each MCP tool call ensures the daemon, then attaches to it', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback listeners are not permitted');
  const { stateDir, paths } = stateDirAndPaths();
  const daemon = await startScriptedDaemon(okResult({ devices: [] }));
  launchesFreshDaemonAt(spawn, paths, daemon.port);
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', stateDir);
  const ensure = vi.spyOn(ensureModule, 'ensureDaemon');
  const capture = vi.spyOn(hostProcess, 'captureHostEnvironment');
  const executor = createCommandToolExecutor();

  try {
    const first = await executor.execute('devices', {});
    const second = await executor.execute('devices', {});

    assert.equal(first.isError, false, JSON.stringify(first.structuredContent));
    assert.equal(second.isError, false, JSON.stringify(second.structuredContent));
    assert.equal(ensure.mock.calls.length, 2, 'one ensure per tool call');
    assert.equal(capture.mock.calls.length, 2, 'one host capture per tool call');
    // The host the ensuring transport used is the one the call captured, not a second capture.
    assert.equal(ensure.mock.calls[0]?.[1], capture.mock.results[0]?.value);
    assert.equal(ensure.mock.calls[1]?.[1], capture.mock.results[1]?.value);
    assert.equal(spawn.mock.calls.length, 1, 'the second call reuses the daemon the first started');
    assert.deepEqual(daemon.rpcCommands, ['devices', 'devices']);
  } finally {
    await closeLoopbackServer(daemon.server);
  }
});
