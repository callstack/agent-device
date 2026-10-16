/**
 * #1801: a caller driving a REMOTE daemon must never be handed a diagnostics
 * path on the daemon's filesystem. These run the real CLI against a daemon
 * started through the public runtime entry, so the request record route is live.
 */

import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCliCapture, type CapturedCliRun } from './cli-capture.ts';
import {
  createPublicWaitCommandSurface,
  startPublicDaemonRuntime,
} from './test-utils/public-daemon-runtime.ts';
import { mkdtempForTestSync, skipWhenLoopbackUnavailable } from '@agent-device/test-kit';

const RECORD_SENTINEL = 'REMOTE_RECORD_SENTINEL';

type RemoteRun = {
  run: CapturedCliRun;
  clientStateDir: string;
  daemonLogPath: string;
  requestId: string;
};

async function runAgainstRemoteDaemon(argv: string[]): Promise<RemoteRun> {
  const clientStateDir = mkdtempForTestSync('agent-device-remote-client-');
  const daemonStateDir = mkdtempForTestSync('agent-device-remote-daemon-');
  const daemon = await startPublicDaemonRuntime({
    stateDir: daemonStateDir,
    serverMode: 'http',
    createCommandSurface: createPublicWaitCommandSurface({ fail: true }),
  });

  try {
    const run = await runCliCapture(argv, {
      useRealDaemonClient: true,
      env: {
        AGENT_DEVICE_STATE_DIR: clientStateDir,
        AGENT_DEVICE_DAEMON_BASE_URL: daemon.baseUrl,
        AGENT_DEVICE_DAEMON_AUTH_TOKEN: daemon.runtime.token,
      },
    });
    const daemonLogPath = findRequestLog(daemonStateDir);
    const requestId = path.basename(daemonLogPath, '.ndjson');
    return { run, clientStateDir, daemonLogPath, requestId };
  } finally {
    await daemon.close();
  }
}

test('a remote failure names a record the caller can actually read', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const { run, clientStateDir, daemonLogPath, requestId } = await runAgainstRemoteDaemon([
    'wait',
    '5000',
    '--platform',
    'macos',
    '--target',
    'desktop',
  ]);
  try {
    const localPath = localRecordPath(clientStateDir, daemonLogPath, requestId);
    assert.equal(run.code, 1);
    assert.match(run.stderr, new RegExp(`Diagnostics Log: ${escapeRegExp(localPath)}`));
    assert.equal(run.stderr.includes(daemonLogPath), false, 'daemon-host path must not be printed');
    assert.match(fs.readFileSync(localPath, 'utf8'), new RegExp(RECORD_SENTINEL));
  } finally {
    fs.rmSync(clientStateDir, { recursive: true, force: true });
  }
});

test('--json carries the caller-local record path, never the daemon-host one', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const { run, clientStateDir, daemonLogPath } = await runAgainstRemoteDaemon([
    'wait',
    '5000',
    '--platform',
    'macos',
    '--target',
    'desktop',
    '--json',
  ]);
  try {
    const payload = JSON.parse(run.stdout) as { error: { logPath?: string } };
    assert.equal(payload.error.logPath?.startsWith(clientStateDir), true);
    assert.equal(fs.existsSync(payload.error.logPath ?? ''), true);
    assert.equal(run.stdout.includes(daemonLogPath), false);
  } finally {
    fs.rmSync(clientStateDir, { recursive: true, force: true });
  }
});

test('--debug prints the fetched record inline and not the local daemon log', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const { run, clientStateDir } = await runAgainstRemoteDaemon([
    'wait',
    '5000',
    '--platform',
    'macos',
    '--target',
    'desktop',
    '--debug',
  ]);
  try {
    // A local daemon log in the caller's state dir must stay unread: it belongs
    // to a different daemon than the one that failed.
    assert.equal(run.stderr.includes('[daemon log]'), false);
    assert.match(run.stderr, /\[remote diagnostics\]/);
    assert.match(run.stderr, new RegExp(RECORD_SENTINEL));
  } finally {
    fs.rmSync(clientStateDir, { recursive: true, force: true });
  }
});

function findRequestLog(stateDir: string): string {
  const sessionsDir = path.join(stateDir, 'sessions');
  const sessionDirs = fs
    .readdirSync(sessionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  const requestLogs = sessionDirs.flatMap((session) => {
    const requestsDir = path.join(sessionsDir, session.name, 'requests');
    if (!fs.existsSync(requestsDir)) return [];
    return fs.readdirSync(requestsDir).map((name) => path.join(requestsDir, name));
  });
  assert.equal(requestLogs.length, 1);
  return requestLogs[0]!;
}

function localRecordPath(clientStateDir: string, daemonLogPath: string, requestId: string): string {
  const sessionDir = path.basename(path.dirname(path.dirname(daemonLogPath)));
  return path.join(
    clientStateDir,
    'remote-diagnostics',
    sessionDir,
    'requests',
    `${requestId}.ndjson`,
  );
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
