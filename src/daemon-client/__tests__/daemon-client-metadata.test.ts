import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import type { DaemonCodeOrigin } from '@agent-device/host-kit/code-signature';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { tryAcquireDaemonRegistration } from '../../daemon-registration-owner.ts';
import { readDaemonInfo, type DaemonInfo } from '../daemon-client-metadata.ts';
import { resolveDaemonPaths } from '../../daemon-resolution.ts';

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
