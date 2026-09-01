/**
 * #1801: a caller driving a REMOTE daemon must never be handed a diagnostics
 * path on the daemon's filesystem. These run the real CLI against a real daemon
 * HTTP server on loopback — the only place the whole chain (daemon error →
 * locator → fetch → rendered line) is observable end to end.
 */

import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeError, AppError } from '@agent-device/kernel/errors';
import { createDaemonHttpServer } from '../daemon/server/http-server.ts';
import { resolveSessionRequestLogPath } from '../daemon/session-store.ts';
import { safeSessionName } from '../daemon/session-paths.ts';
import type { DaemonRequest, DaemonResponse } from '../daemon/types.ts';
import { runCliCapture, type CapturedCliRun } from './cli-capture.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from './test-utils/loopback.ts';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';

const DAEMON_TOKEN = 'daemon-secret';
const DAEMON_SESSION = 'cwd:abcdef0123456789:default';
const RECORD_SENTINEL = 'REMOTE_RECORD_SENTINEL';

type RemoteRun = {
  run: CapturedCliRun;
  clientStateDir: string;
  daemonLogPath: string;
  requestId: string;
};

/**
 * Runs `argv` against a loopback daemon that always fails the command and
 * writes the request's diagnostics record, exactly as the real router does.
 * `serveRecord: false` models a daemon with no diagnostics route (an older
 * release), so the fetch fails.
 */
async function runAgainstRemoteDaemon(
  argv: string[],
  options: { serveRecord: boolean },
): Promise<RemoteRun> {
  const clientStateDir = mkdtempForTestSync('agent-device-remote-client-');
  const daemonStateDir = mkdtempForTestSync('agent-device-remote-daemon-');
  const daemonSessionsDir = path.join(daemonStateDir, 'sessions');
  const resolveRecordPath = (session: string, requestId: string | undefined): string =>
    resolveSessionRequestLogPath(path.join(daemonSessionsDir, safeSessionName(session)), requestId);
  let requestId = '';
  let daemonLogPath = '';

  const handleRequest = async (req: DaemonRequest): Promise<DaemonResponse> => {
    requestId = req.meta?.requestId ?? '';
    daemonLogPath = resolveRecordPath(DAEMON_SESSION, requestId);
    fs.mkdirSync(path.dirname(daemonLogPath), { recursive: true });
    fs.writeFileSync(daemonLogPath, `{"phase":"request_failed","data":"${RECORD_SENTINEL}"}\n`);
    return {
      ok: false,
      error: normalizeError(new AppError('COMMAND_FAILED', 'wait timed out'), {
        logPath: daemonLogPath,
        diagnosticsRecord: { session: DAEMON_SESSION, requestId },
      }),
    };
  };

  const server = await createDaemonHttpServer({
    token: DAEMON_TOKEN,
    handleRequest,
    ...(options.serveRecord
      ? { resolveRequestDiagnosticsPath: (ref) => resolveRecordPath(ref.session, ref.requestId) }
      : {}),
  });

  try {
    const port = await listenOnLoopback(server);
    const run = await runCliCapture(argv, {
      useRealDaemonClient: true,
      env: {
        AGENT_DEVICE_STATE_DIR: clientStateDir,
        AGENT_DEVICE_DAEMON_BASE_URL: `http://127.0.0.1:${port}`,
        AGENT_DEVICE_DAEMON_AUTH_TOKEN: DAEMON_TOKEN,
      },
    });
    return { run, clientStateDir, daemonLogPath, requestId };
  } finally {
    await closeLoopbackServer(server);
    fs.rmSync(daemonStateDir, { recursive: true, force: true });
  }
}

test('a remote failure names a record the caller can actually read', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const { run, clientStateDir, daemonLogPath, requestId } = await runAgainstRemoteDaemon(
    ['clipboard', 'write', 'hello'],
    { serveRecord: true },
  );
  try {
    const localPath = path.join(
      clientStateDir,
      'remote-diagnostics',
      safeSessionName(DAEMON_SESSION),
      'requests',
      `${requestId}.ndjson`,
    );
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

  const { run, clientStateDir, daemonLogPath } = await runAgainstRemoteDaemon(
    ['clipboard', 'write', 'hello', '--json'],
    { serveRecord: true },
  );
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

  const { run, clientStateDir } = await runAgainstRemoteDaemon(
    ['clipboard', 'write', 'hello', '--debug'],
    { serveRecord: true },
  );
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

test('an unfetchable remote record says so instead of naming a path', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const { run, clientStateDir, daemonLogPath, requestId } = await runAgainstRemoteDaemon(
    ['clipboard', 'write', 'hello', '--json'],
    { serveRecord: false },
  );
  try {
    const payload = JSON.parse(run.stdout) as {
      error: { logPath?: string; logPathUnavailable?: string };
    };
    // A path may still be named — the CLI's own client-side record, written on
    // this machine — but never the daemon host's, and never a record the fetch
    // failed to produce.
    assert.notEqual(payload.error.logPath, daemonLogPath);
    assert.equal(payload.error.logPath?.includes('remote-diagnostics') ?? false, false);
    assert.match(
      payload.error.logPathUnavailable ?? '',
      new RegExp(`^remote daemon http://127\\.0\\.0\\.1:\\d+, request ${requestId}: HTTP 404$`),
    );
    assert.equal(run.stdout.includes(daemonLogPath), false);
  } finally {
    fs.rmSync(clientStateDir, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
