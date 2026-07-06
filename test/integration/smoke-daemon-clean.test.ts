import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { skipWhenLoopbackUnavailable } from '../../src/__tests__/test-utils/loopback.ts';
import { runCmdSync } from '../../src/utils/exec.ts';
import { stopProcessForTakeover } from '../../src/daemon/daemon-process.ts';
import { isProcessAlive } from '../../src/utils/host-process.ts';
import { runCliJson } from './test-helpers.ts';

type DaemonInfo = {
  pid: number;
  processStartTime?: string;
};

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
  } finally {
    if (info) {
      await stopProcessForTakeover(info.pid, {
        termTimeoutMs: 1_500,
        killTimeoutMs: 1_500,
        expectedStartTime: info.processStartTime,
      });
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

function readDaemonInfo(stateDir: string): DaemonInfo {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'daemon.json'), 'utf8')) as DaemonInfo;
}
