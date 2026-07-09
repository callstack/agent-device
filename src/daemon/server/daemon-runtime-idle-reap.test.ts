import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { resolveDaemonPaths } from '../config.ts';
import { startDaemonRuntime } from './daemon-runtime.ts';

test('daemon runtime self-reaps after the idle window when nothing ever uses it', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-daemon-idle-reap-rt-'));
  const paths = resolveDaemonPaths(stateDir);
  let exitCode: number | undefined;
  let resolveExit: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  try {
    const runtime = await startDaemonRuntime({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '80',
      },
      exit: (code) => {
        exitCode = code;
        resolveExit();
      },
      registerProcessHandlers: false,
      stderr: { write: () => {} },
      stdout: { write: () => {} },
    });
    assert.notEqual(runtime, null);
    assert.ok(fs.existsSync(paths.lockPath), 'daemon lock should be held right after startup');

    await Promise.race([
      exited,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('idle reap did not fire in time')), 2_000),
      ),
    ]);

    assert.equal(exitCode, 0);
    assert.equal(fs.existsSync(paths.infoPath), false);
    assert.equal(fs.existsSync(paths.lockPath), false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('daemon runtime never self-reaps when AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS is 0', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-daemon-idle-reap-off-'));
  let exitCode: number | undefined;

  try {
    const runtime = await startDaemonRuntime({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
      },
      exit: (code) => {
        exitCode = code;
      },
      registerProcessHandlers: false,
      stderr: { write: () => {} },
      stdout: { write: () => {} },
    });
    assert.notEqual(runtime, null);

    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(exitCode, undefined);
    await runtime?.shutdown();
    assert.equal(exitCode, 0);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
