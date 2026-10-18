import { cleanupDaemonTestState } from './support/daemon-test-cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { skipWhenLoopbackUnavailable } from '@agent-device/test-kit';
import { runCmdSync } from '@agent-device/host-kit/command';
import { isProcessAlive, readProcessStartTime } from '@agent-device/host-kit/process';
import { stopAndRetireDaemon } from '@agent-device/daemon-contracts/daemon-registration-owner';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';

import { assertNoDaemonLeaks } from './support/daemon-leak-oracle.ts';
import { runCliJson } from './test-helpers.ts';

type DaemonInfo = {
  pid: number;
  processStartTime?: string;
};

test('clean daemon retains metadata when a live recorded process is not a verified daemon', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-clean-retained-'));
  const identity = { pid: process.pid, processStartTime: readProcessStartTime(process.pid) };
  assert.ok(identity.processStartTime);
  const contents = JSON.stringify(identity);
  fs.writeFileSync(path.join(stateDir, 'daemon.json'), contents);
  fs.writeFileSync(path.join(stateDir, 'daemon.lock'), contents);
  try {
    const cleanup = runCmdSync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/clean-daemon.ts'],
      {
        env: { ...process.env, AGENT_DEVICE_STATE_DIR: stateDir },
        timeoutMs: 5_000,
        allowFailure: true,
      },
    );
    assert.notEqual(cleanup.exitCode, 0, 'unconfirmed exit cannot complete cleanup');
    assert.match(
      cleanup.stderr,
      /Daemon cleanup retained state because retirement could not be confirmed/,
    );
    assert.match(cleanup.stderr, /exit-unconfirmed/);
    assert.equal(fs.readFileSync(path.join(stateDir, 'daemon.json'), 'utf8'), contents);
    assert.equal(fs.readFileSync(path.join(stateDir, 'daemon.lock'), 'utf8'), contents);
    assert.equal(isProcessAlive(process.pid), true);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('clean daemon script stops a live daemon before removing metadata', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) {
    return;
  }

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-clean-daemon-'));
  let info: DaemonInfo | null = null;
  try {
    const cli = runCliJson(['session', 'list', '--json', '--state-dir', stateDir]);
    assert.equal(cli.status, 0, `${cli.stderr}\n${cli.stdout}`);
    assert.equal(cli.json?.success, true, JSON.stringify(cli.json));

    info = readDaemonInfo(stateDir);
    assert.equal(isProcessAlive(info.pid), true);

    const infoPath = path.join(stateDir, 'daemon.json');
    const original = fs.readFileSync(infoPath, 'utf8');
    for (const ownership of ['embedded', 'unrecognized']) {
      const record = JSON.stringify({ ...JSON.parse(original), ownership });
      fs.writeFileSync(infoPath, record);
      const refused = runCmdSync(
        process.execPath,
        ['--experimental-strip-types', 'scripts/clean-daemon.ts'],
        {
          env: { ...process.env, AGENT_DEVICE_STATE_DIR: stateDir },
          timeoutMs: 5_000,
          allowFailure: true,
        },
      );
      assert.notEqual(refused.exitCode, 0);
      assert.match(refused.stderr, ownership === 'embedded' ? /embedded-owner/ : /owner-unproven/);
      assert.equal(
        isProcessAlive(info.pid),
        true,
        'the same otherwise signalable daemon stays alive',
      );
      assert.equal(fs.readFileSync(infoPath, 'utf8'), record);
      assert.equal(fs.existsSync(path.join(stateDir, 'daemon.lock')), true);
    }
    const legacy = JSON.parse(original);
    delete legacy.ownership;
    fs.writeFileSync(infoPath, JSON.stringify(legacy));

    const cleanup = runCmdSync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/clean-daemon.ts'],
      {
        env: { ...process.env, AGENT_DEVICE_STATE_DIR: stateDir },
        timeoutMs: 30_000,
      },
    );
    assert.equal(cleanup.exitCode, 0, cleanup.stderr);
    assert.equal(isProcessAlive(info.pid), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'daemon.json')), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'daemon.lock')), false);
    // #1781 B1: the stopped daemon must take every process it owned with it and
    // leave only classified artifacts in its state dir.
    await assertNoDaemonLeaks({ stateDir, daemonPids: [info.pid], phase: 'after-shutdown' });
  } finally {
    await cleanupDaemonTestState(stateDir, info ?? null);
  }
});

test('forced retirement waits for a real daemon and reclaims its abandoned registration claim', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-forced-retirement-'));
  let info: DaemonInfo | undefined;
  try {
    const cli = runCliJson(['session', 'list', '--json', '--state-dir', stateDir]);
    assert.equal(cli.status, 0, `${cli.stderr}\n${cli.stdout}`);
    info = readDaemonInfo(stateDir);
    const paths = resolveDaemonPaths(stateDir);
    assert.equal(fs.existsSync(paths.lockPath), true);
    const result = await stopAndRetireDaemon({
      paths,
      // The record is the one this row's CLI-started daemon published of itself, which is a detached
      // daemon: what the row retires is that lifetime, under that owner.
      observed: {
        pid: info.pid,
        startTime: info.processStartTime ?? null,
        ownership: 'detached',
      },
      mode: 'force',
    });
    assert.equal(result.status, 'retired', JSON.stringify(result));
    if (result.status !== 'retired') assert.fail('retirement not confirmed');
    assert.equal(result.termination.mode, 'forced');
    assert.equal(result.removedInfo, true);
    assert.equal(isProcessAlive(info.pid), false);
    assert.equal(fs.existsSync(paths.infoPath), false);
    assert.equal(fs.existsSync(paths.lockPath), false);
  } finally {
    await cleanupDaemonTestState(stateDir, info ?? null);
  }
});

function readDaemonInfo(stateDir: string): DaemonInfo {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'daemon.json'), 'utf8')) as DaemonInfo;
}
