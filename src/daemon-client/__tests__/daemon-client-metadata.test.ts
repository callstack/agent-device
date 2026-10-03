import assert from 'node:assert/strict';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import type { DaemonCodeOrigin } from '@agent-device/host-kit/code-signature';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { tryAcquireDaemonRegistration } from '../../daemon-registration-owner.ts';
import {
  readDaemonInfo,
  cleanupFailedDaemonStartupMetadata,
  stopDaemonProcessForTakeover,
  type DaemonInfo,
} from '../daemon-client-metadata.ts';
import { isAgentDeviceDaemonProcess, stopDaemonProcess } from '../../daemon-process.ts';
import { resolveDaemonPaths } from '../../daemon-resolution.ts';

vi.mock('../../daemon-process.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../daemon-process.ts')>()),
  isAgentDeviceDaemonProcess: vi.fn(),
  stopDaemonProcess: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

// The reuse decision is only as good as the identity that survives the round trip
// through `daemon.json`: a client cannot compare what the file lost (#2458).

function scratchStateDir(): [stateDir: string, infoPath: string] {
  const stateDir = mkdtempForTestSync('agent-device-daemon-identity-');
  return [stateDir, path.join(stateDir, 'daemon.json')];
}

async function publishInfo(codeOrigin: DaemonCodeOrigin): Promise<DaemonInfo | null> {
  const [stateDir, infoPath] = scratchStateDir();
  const registration = await tryAcquireDaemonRegistration(resolveDaemonPaths(stateDir));
  assert.equal(registration.status, 'acquired');
  if (registration.status !== 'acquired') throw new Error('registration refused');
  registration.owner.publish({
    httpPort: 41_234,
    token: 'local-secret',
    version: '0.0.0-test',
    codeOrigin,
    codeSignature: 'graph:1:abc',
  });
  const published = readDaemonInfo(infoPath);
  await registration.owner.finish();
  return published;
}

test('a daemon publishes the code origin its client reads back', async () => {
  for (const codeOrigin of ['installed', 'checkout'] as const) {
    assert.equal((await publishInfo(codeOrigin))?.codeOrigin, codeOrigin);
  }
});

test('a registration this version did not write reads back unreported', () => {
  // Shaped like a daemon published before the field existed, and like a value no
  // version of this writer produces.
  for (const contents of [
    { httpPort: 41_234, token: 'local-secret', pid: 7 },
    { httpPort: 41_234, token: 'local-secret', pid: 7, codeOrigin: 'something-else' },
  ]) {
    const [, infoPath] = scratchStateDir();
    fs.writeFileSync(infoPath, JSON.stringify(contents));

    assert.equal(readDaemonInfo(infoPath)?.codeOrigin, undefined);
  }
});

for (const artifact of ['daemon.json', 'daemon.lock']) {
  test(`unconfirmed startup stop retains ${artifact} without claiming cleanup`, async () => {
    const [stateDir] = scratchStateDir();
    const paths = resolveDaemonPaths(stateDir);
    const file = path.join(stateDir, artifact);
    const contents = JSON.stringify({
      pid: 7,
      processStartTime: 'start',
      port: 1234,
      token: 'secret',
    });
    fs.writeFileSync(file, contents);
    vi.mocked(isAgentDeviceDaemonProcess).mockReturnValue(true);
    vi.mocked(stopDaemonProcess).mockResolvedValue({ status: 'retained', reason: 'exit-timeout' });
    const result = await cleanupFailedDaemonStartupMetadata(paths, 'start_error');
    assert.equal(fs.readFileSync(file, 'utf8'), contents);
    assert.equal(result.removedInfo, false);
    assert.equal(result.removedLock, false);
    assert.equal(result.stoppedInfoProcess, false);
    assert.equal(result.stoppedLockProcess, false);
    assert.match(result.error ?? '', /exit could not be confirmed/);
  });
}

test('a retained takeover keeps its reason at the normalized error boundary', async () => {
  vi.mocked(stopDaemonProcess).mockResolvedValue({ status: 'retained', reason: 'exit-timeout' });
  await assert.rejects(
    stopDaemonProcessForTakeover({ pid: 7, token: 'secret', processStartTime: 'start' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(normalizeError(error).details?.reason, 'daemon_exit_unconfirmed');
      return true;
    },
  );
});
