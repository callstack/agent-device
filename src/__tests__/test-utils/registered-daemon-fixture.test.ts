import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { resolveDaemonPaths } from '../../daemon-resolution.ts';
import { stopDaemonProcess } from '../../daemon-process.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';
import {
  spawnRegisteredDaemonFixture,
  waitForRegisteredDaemonFixture,
  finishRegisteredDaemonFixture,
} from './registered-daemon-fixture.ts';

test('a joined fixture exit refuses its remaining registration metadata', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-fixture-exited-publication-'));
  const child = spawnRegisteredDaemonFixture(
    paths,
    {
      httpPort: 4210,
      token: 'fixture',
      version: 'test',
      codeOrigin: 'checkout',
      codeSignature: 'fixture',
    },
    undefined,
  );
  try {
    const observed = await waitForRegisteredDaemonFixture(paths, child);
    assert.equal(
      (
        await stopDaemonProcess(
          { pid: child.pid, startTime: observed.processStartTime ?? null },
          { mode: 'force', termTimeoutMs: 0, killTimeoutMs: 1_000 },
        )
      ).status,
      'exited',
    );
    await child.exited;
    assert.equal(fs.existsSync(paths.infoPath), true);
    await assert.rejects(waitForRegisteredDaemonFixture(paths, child), /exited before publication/);
  } finally {
    await finishRegisteredDaemonFixture(paths.baseDir);
  }
});
