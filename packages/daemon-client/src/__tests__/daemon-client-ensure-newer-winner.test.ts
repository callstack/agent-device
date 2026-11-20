import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { closeLoopbackServer, skipWhenLoopbackUnavailable } from '@agent-device/test-kit';
import { isProcessAlive } from '@agent-device/host-kit/process';
import { readVersion } from '@agent-device/host-kit/version';
import { DAEMON_STARTUP_EXIT_CODES } from '@agent-device/daemon-contracts/daemon-registration-owner';
import {
  finishRegisteredDaemonFixtures,
  planRegisteredDaemonLaunches,
  spawnRegisteredDaemonFixture,
  waitForRegisteredDaemonFixture,
} from './registered-daemon-fixture.ts';
import { currentDaemonCodeSignature } from './code-signature-fixture.ts';
import {
  failureOf,
  identityIn,
  okResult,
  startScriptedDaemon,
  stateDirAndPaths,
} from './explicit-lifecycle-fixture.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmdDetachedMonitored: vi.fn(),
}));
vi.mock('@agent-device/host-kit/retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/retry')>()),
  sleep: vi.fn(async () => {}),
}));
import { runCmdDetachedMonitored, type ExecDetachedExit } from '@agent-device/host-kit/command';
import { sleep } from '@agent-device/host-kit/retry';
import { ensureDaemon } from '../daemon-client-ensure.ts';

// A startup race `ensureDaemon` loses: the daemon it launched finds the state directory claimed by
// another process, exits, and the winner is a daemon newer than this client, which it may neither
// use nor replace. Both halves of the race are real children with real registrations, planted at the
// launch seam, so the reason the caller gets is the one the startup path really produced.

const spawn = vi.mocked(runCmdDetachedMonitored);
const actualRetry = await vi.importActual<typeof import('@agent-device/host-kit/retry')>(
  '@agent-device/host-kit/retry',
);

afterEach(async () => {
  vi.restoreAllMocks();
  spawn.mockReset();
  vi.mocked(sleep).mockReset();
  vi.mocked(sleep).mockImplementation(async () => {});
  await finishRegisteredDaemonFixtures();
});

test('ensureDaemon reports a newer daemon that wins a startup race as incompatible', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { stateDir, paths } = stateDirAndPaths();
  const newer = await startScriptedDaemon(okResult({ via: 'newer-daemon' }));
  const fresh = await startScriptedDaemon(okResult({}));
  const barrier = path.join(paths.baseDir, 'contender-barrier');
  fs.mkdirSync(paths.baseDir, { recursive: true });
  // Real waits: this start must poll its own child and the winner's registration.
  vi.mocked(sleep).mockImplementation(actualRetry.sleep);
  let winner: ReturnType<typeof spawnRegisteredDaemonFixture> | undefined;
  let loserExit: ExecDetachedExit | undefined;
  spawn.mockImplementation(
    planRegisteredDaemonLaunches([
      {
        kind: 'registered',
        paths,
        fields: {
          httpPort: fresh.port,
          token: 'local-secret',
          version: readVersion(),
          codeOrigin: 'checkout',
          codeSignature: currentDaemonCodeSignature(),
        },
        acquisitionBarrier: barrier,
        observe(child) {
          void child.exited.then((exit) => {
            loserExit = exit;
          });
        },
        companions: [
          {
            kind: 'registered',
            paths,
            fields: {
              httpPort: newer.port,
              token: 'local-secret',
              version: '999.0.0',
              codeOrigin: 'checkout',
              codeSignature: currentDaemonCodeSignature(),
              capabilities: ['quiesce'],
            },
            observe(child) {
              winner = child;
              // Released whether or not the winner published, so the launched child never waits forever.
              const release = () => fs.writeFileSync(barrier, 'go');
              void waitForRegisteredDaemonFixture(paths, child).then(release, release);
            },
          },
        ],
      },
      {
        kind: 'refuse',
        error: new Error('a newer daemon that won the race is never replaced by another launch'),
      },
    ]),
  );

  try {
    const error = await failureOf(ensureDaemon({ stateDir, daemonTransport: 'http' }));

    assert.equal(error.details?.reason, 'daemon-incompatible');
    assert.equal(error.details?.mismatch, 'newer');
    assert.equal(identityIn(error, 'daemon').version, '999.0.0');
    assert.equal(identityIn(error, 'client').version, readVersion());
    assert.equal(loserExit?.exitCode, DAEMON_STARTUP_EXIT_CODES.busy, 'the launch lost the race');
    assert.ok(winner);
    assert.equal(isProcessAlive(winner.pid), true, 'the newer daemon keeps running');
    assert.deepEqual(newer.rpcCommands, [], 'the newer daemon is never asked to leave');
    assert.equal(spawn.mock.calls.length, 1, 'no replacement daemon is launched');
    assert.ok(fs.existsSync(paths.infoPath), 'the newer daemon keeps its registration');
  } finally {
    await closeLoopbackServer(newer.server);
    await closeLoopbackServer(fresh.server);
  }
});
