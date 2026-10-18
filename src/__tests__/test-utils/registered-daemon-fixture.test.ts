import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { stopDaemonProcess } from '@agent-device/daemon-contracts/daemon-process';
import {
  DAEMON_STARTUP_EXIT_CODES,
  resolveDaemonStartupPhasesPath,
} from '@agent-device/daemon-contracts/daemon-registration-owner';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import {
  launchRegisteredDaemonFixtureArgs,
  registeredDaemonFixtureArgs,
  spawnRegisteredDaemonFixture,
  waitForRegisteredDaemonFixture,
  finishRegisteredDaemonFixture,
} from './registered-daemon-fixture.ts';

test('args built before any launch keep their own entry script under a concurrent second build', async () => {
  // Under a shared entry path child 1 would run child 2's switches and carry the wrong marker.
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-fixture-entry-isolation-'));
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(path.join(paths.baseDir, 'defer-publication'), 'wait');
  const fields = {
    httpPort: 4211,
    token: 'fixture',
    version: 'test',
    codeOrigin: 'checkout' as const,
    codeSignature: 'fixture',
  };
  const firstArgs = registeredDaemonFixtureArgs(paths, fields, undefined, {
    emitStartupMarkerBeforeAcquisition: true,
  });
  const secondArgs = registeredDaemonFixtureArgs(paths, fields, undefined, {
    emitStartupMarker: true,
  });
  assert.notEqual(firstArgs[1], secondArgs[1]);
  const first = launchRegisteredDaemonFixtureArgs(paths, firstArgs, { stdio: 'ignore' });
  try {
    const held = path.join(paths.baseDir, `registration-held-${first.pid}`);
    for (let attempt = 0; !fs.existsSync(held); attempt += 1) {
      assert.ok(attempt < 400, 'child 1 never acquired the registration');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const second = launchRegisteredDaemonFixtureArgs(paths, secondArgs, { stdio: 'ignore' });
    assert.equal((await second.exited).exitCode, DAEMON_STARTUP_EXIT_CODES.busy);
    const ownRecord = resolveDaemonStartupPhasesPath(paths.baseDir, first.pid);
    const text = fs.readFileSync(ownRecord, 'utf8');
    assert.match(text, /modules-loaded/);
    assert.doesNotMatch(
      text,
      /lock-acquired/,
      "child 1 must run the script built for it, not the second build's switches",
    );
  } finally {
    await finishRegisteredDaemonFixture(paths.baseDir);
  }
});

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
