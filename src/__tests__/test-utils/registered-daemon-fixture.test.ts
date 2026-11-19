import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { stopDaemonProcess } from '@agent-device/daemon-contracts/daemon-process';
import { DAEMON_STARTUP_EXIT_CODES } from '@agent-device/daemon-contracts/daemon-registration-owner';
import { parseDaemonStartupProgressMessage } from '@agent-device/daemon-contracts/daemon-startup-phases';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import {
  launchRegisteredDaemonFixtureArgs,
  registeredDaemonFixtureArgs,
  spawnRegisteredDaemonFixture,
  planRegisteredDaemonLaunches,
  waitForFixtureFile,
  waitForRegisteredDaemonFixture,
  finishRegisteredDaemonFixture,
} from './registered-daemon-fixture.ts';

test('a launch plan returns the registered child identity and joins that child at teardown', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-planned-identity-'));
  const launch = planRegisteredDaemonLaunches([
    {
      kind: 'registered',
      paths,
      fields: {
        httpPort: 4210,
        token: 'fixture',
        version: 'test',
        codeOrigin: 'checkout',
        codeSignature: 'fixture',
      },
    },
  ]);
  const child = launch('node', [], { stdio: 'ignore' });
  try {
    const observed = await waitForRegisteredDaemonFixture(paths, child);
    assert.equal(observed.pid, child.pid);
    assert.notEqual(child.pid, process.pid);
  } finally {
    await finishRegisteredDaemonFixture(paths.baseDir);
  }
  assert.equal((await child.exited).pid, child.pid);
  assert.equal(fs.existsSync(paths.baseDir), false);
});

test('args built before any launch keep their own entry script under a concurrent second build', async () => {
  // Under a shared entry path child 1 would run child 2's switches and carry the wrong phase.
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
    emitStartupPhaseBeforeAcquisition: true,
  });
  const secondArgs = registeredDaemonFixtureArgs(paths, fields, undefined, {
    emitStartupPhase: true,
  });
  assert.notEqual(firstArgs[1], secondArgs[1]);
  const ipc = ['ignore', 'ignore', 'ignore', 'ipc'] as const;
  const channelEnv = {
    ...process.env,
    AGENT_DEVICE_DAEMON_PROGRESS_CHANNEL: '1',
  };
  const first = launchRegisteredDaemonFixtureArgs(paths, firstArgs, {
    stdio: [...ipc],
    env: channelEnv,
  });
  const firstMessages: unknown[] = [];
  const secondMessages: unknown[] = [];
  first.channel?.onMessage((message) => firstMessages.push(message));
  try {
    await waitForFixtureFile(path.join(paths.baseDir, `registration-held-${first.pid}`));
    const second = launchRegisteredDaemonFixtureArgs(paths, secondArgs, {
      stdio: [...ipc],
      env: channelEnv,
    });
    second.channel?.onMessage((message) => secondMessages.push(message));
    assert.equal((await second.exited).exitCode, DAEMON_STARTUP_EXIT_CODES.busy);
    const firstPhases = firstMessages.map((m) => parseDaemonStartupProgressMessage(m)?.phase);
    assert.deepEqual(firstPhases, ['modules-loaded']);
    assert.equal(
      firstPhases.includes('lock-acquired'),
      false,
      'child 1 must run the script built for it, not child 2’s',
    );
    assert.deepEqual(
      secondMessages.map((m) => parseDaemonStartupProgressMessage(m)?.phase),
      [],
      'the busy child exits before its post-acquisition phase',
    );
    assert.deepEqual(
      fs.readdirSync(paths.baseDir).filter((entry) => entry.startsWith('daemon-startup-phases')),
      [],
      'channel-reported phases must not write any marker file',
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
