import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import path from 'node:path';
import { test } from 'vitest';
import type { DaemonCodeOrigin } from '@agent-device/host-kit/code-signature';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { tryAcquireDaemonRegistration } from '@agent-device/daemon-contracts/daemon-registration-owner';
import {
  readDaemonInfo,
  readRegisteredDaemon,
  type DaemonInfo,
} from '../daemon-client-metadata.ts';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';

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

test('a daemon record without capabilities reads as a daemon with none', () => {
  const [, infoPath] = scratchStateDir();
  fs.writeFileSync(infoPath, JSON.stringify({ httpPort: 41_234, token: 'legacy', pid: 1 }));
  assert.deepEqual(readDaemonInfo(infoPath)?.capabilities, []);
  fs.writeFileSync(
    infoPath,
    JSON.stringify({ httpPort: 41_234, token: 'new', pid: 1, capabilities: ['quiesce', 'future'] }),
  );
  assert.deepEqual(readDaemonInfo(infoPath)?.capabilities, ['quiesce']);
});

test('registered admission requires a valid process identity, token and endpoint', async () => {
  const dir = mkdtempForTestSync('record-validation-');
  const file = resolveDaemonPaths(dir).infoPath;
  for (const [record, valid] of [
    [{ pid: 1, token: '', port: 1 }, false],
    [{ pid: 0, token: 'x', port: 1234 }, false],
    [{ pid: -1, token: 'x', port: 1234 }, false],
    [{ pid: 1, token: 'x' }, false],
    [{ pid: 1, token: 'x', port: -1 }, false],
    [{ pid: 1, token: 'x', httpPort: 65536 }, false],
    [{ pid: 1, token: 'x', port: 1234, transport: 'socket' }, true],
    [{ pid: 1, token: 'x', httpPort: 1234, transport: 'http' }, true],
    [{ pid: 1, token: 'x', httpPort: 65535 }, true],
  ] as const) {
    fs.writeFileSync(file, JSON.stringify(record));
    if (valid) assert.ok(await readRegisteredDaemon(resolveDaemonPaths(dir)));
    else {
      for (const options of [undefined, { required: true }] as const) {
        await assert.rejects(
          readRegisteredDaemon(resolveDaemonPaths(dir), options),
          (error: unknown) =>
            error instanceof AppError && error.details?.reason === 'daemon-record-unreadable',
          JSON.stringify(record),
        );
      }
    }
  }
});

test('unproven ownership is refused before nullable or required record lookup', async () => {
  const [stateDir] = scratchStateDir();
  const paths = resolveDaemonPaths(stateDir);
  fs.writeFileSync(paths.lockPath, 'not a lock directory');
  const unproven = (error: unknown) =>
    error instanceof AppError &&
    error.details?.reason === 'daemon_registration_unproven' &&
    error.details?.stateDir === stateDir;
  await assert.rejects(readRegisteredDaemon(paths), unproven);
  await assert.rejects(readRegisteredDaemon(paths, { required: true }), unproven);
});

test('present invalid or unreadable metadata never admits a new daemon', async () => {
  for (const contents of ['{not json', '[]', 'null', '{}']) {
    const [stateDir] = scratchStateDir();
    const paths = resolveDaemonPaths(stateDir);
    fs.writeFileSync(paths.infoPath, contents);
    for (const options of [undefined, { required: true }] as const) {
      await assert.rejects(
        readRegisteredDaemon(paths, options),
        (error: unknown) =>
          error instanceof AppError && error.details?.reason === 'daemon-record-unreadable',
      );
    }
    assert.equal(fs.readFileSync(paths.infoPath, 'utf8'), contents);
  }
  const [stateDir] = scratchStateDir();
  const paths = resolveDaemonPaths(stateDir);
  fs.mkdirSync(paths.infoPath);
  await assert.rejects(
    readRegisteredDaemon(paths),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'daemon-record-unreadable',
  );
});
