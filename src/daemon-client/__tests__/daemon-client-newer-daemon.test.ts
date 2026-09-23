import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmdDetached: vi.fn(),
  runCmdDetachedMonitored: vi.fn(),
  runCmdSync: vi.fn(() => ({ exitCode: 1, stdout: '', stderr: '' })),
}));

import { resolveDaemonPaths } from '../../daemon-resolution.ts';
import { sendToDaemon } from '../daemon-client.ts';
import { closeLoopbackServer, supportsLoopbackBind } from '../../__tests__/test-utils/loopback.ts';
import {
  captureStderr,
  startHttpDaemonFixture,
} from '../../__tests__/test-utils/daemon-http-fixture.ts';
import { AppError } from '@agent-device/kernel/errors';
import { runCmdDetachedMonitored } from '@agent-device/host-kit/command';

// The daemon-version half of the takeover ladder (`resolveDaemonTakeover`): an older CLI
// hoisted onto PATH meets the daemon a newer install started, with live sessions attached. It must
// neither spawn a replacement nor kill the daemon.

const mockRunCmdDetached = vi.mocked(runCmdDetachedMonitored);

afterEach(() => {
  mockRunCmdDetached.mockReset();
  vi.unstubAllEnvs();
});

test('sendToDaemon refuses to replace a reachable daemon newer than the client', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }
  const stateDir = mkdtempForTestSync('agent-device-daemon-newer-refused-');
  const paths = resolveDaemonPaths(stateDir);
  const newerDaemon = await startHttpDaemonFixture({ via: 'newer-daemon' });
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', stateDir);
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(
    paths.infoPath,
    `${JSON.stringify({
      token: 'local-secret',
      pid: 999_999,
      version: '999.0.0',
      httpPort: newerDaemon.port,
      transport: 'http',
    })}\n`,
    'utf8',
  );
  const stderrCapture = captureStderr();

  try {
    await assert.rejects(
      () =>
        sendToDaemon({
          session: 'default',
          command: 'newer-daemon-smoke',
          positionals: [],
          flags: { stateDir, daemonTransport: 'http' },
          meta: { requestId: 'req-newer-daemon' },
        }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.match(error.message, /v999\.0\.0\) is newer than this client/);
        assert.match(String(error.details?.hint), /agent-device daemon stop --state-dir /);
        return true;
      },
    );

    assert.equal(mockRunCmdDetached.mock.calls.length, 0, 'no replacement daemon is spawned');
    assert.deepEqual(newerDaemon.seenPaths, ['GET /health']);
    assert.equal(stderrCapture.read(), '', 'no takeover notice is printed');
    assert.ok(fs.existsSync(paths.infoPath), 'the newer daemon keeps its metadata');
  } finally {
    stderrCapture.restore();
    await closeLoopbackServer(newerDaemon.server);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
