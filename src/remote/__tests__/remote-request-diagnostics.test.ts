import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { normalizeError, throwDaemonError, type DaemonError } from '@agent-device/kernel/errors';
import { localizeRemoteDaemonError } from '../remote-request-diagnostics.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../__tests__/test-utils/loopback.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

const DAEMON_LOG_PATH = '/Users/daemon-host/.agent-device/sessions/default/requests/abc123.ndjson';
const RECORD = '{"phase":"request_failed","data":{"error":"no element"}}\n';

function remoteError(): DaemonError {
  return {
    code: 'COMMAND_FAILED',
    message: 'wait timed out',
    logPath: DAEMON_LOG_PATH,
    diagnosticsRecord: { session: 'cwd:9f1:default', requestId: 'abc123' },
  };
}

/** Serves the record for any diagnostics request, or fails every request. */
async function withRecordServer(
  behavior: 'serve' | 'reject',
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const requestTargets: string[] = [];
  const server = http.createServer((req, res) => {
    requestTargets.push(req.url ?? '');
    if (behavior === 'reject') {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson');
    res.end(RECORD);
  });
  try {
    const port = await listenOnLoopback(server);
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await closeLoopbackServer(server);
  }
  if (behavior === 'serve') {
    assert.deepEqual(requestTargets, ['/sessions/cwd%3A9f1%3Adefault/requests/abc123/diagnostics']);
  }
}

test('a fetched remote record replaces the daemon-host path with a caller-local one', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const stateDir = mkdtempForTestSync('agent-device-remote-diagnostics-');
  try {
    await withRecordServer('serve', async (baseUrl) => {
      const localized = await localizeRemoteDaemonError(remoteError(), {
        endpoint: { baseUrl, token: 'daemon-secret' },
        stateDir,
      });
      const expectedPath = path.join(
        stateDir,
        'remote-diagnostics',
        'cwd_9f1_default',
        'requests',
        'abc123.ndjson',
      );
      assert.equal(localized.logPath, expectedPath);
      assert.equal(fs.readFileSync(expectedPath, 'utf8'), RECORD);
      assert.equal(localized.logPathUnavailable, undefined);
      assert.equal(
        JSON.stringify(localized).includes(DAEMON_LOG_PATH),
        false,
        'nothing on the localized error may carry the daemon-host path',
      );

      // The rendered and JSON-rendered views must never name the daemon's path.
      const normalized = normalizeError(
        (() => {
          try {
            throwDaemonError(localized);
          } catch (error) {
            return error;
          }
        })(),
      );
      assert.equal(normalized.logPath, expectedPath);
      assert.notEqual(normalized.logPath, DAEMON_LOG_PATH);
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('an unreachable record leaves no path and names the daemon and request instead', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const stateDir = mkdtempForTestSync('agent-device-remote-diagnostics-');
  try {
    await withRecordServer('reject', async (baseUrl) => {
      const localized = await localizeRemoteDaemonError(remoteError(), {
        endpoint: { baseUrl, token: 'daemon-secret' },
        stateDir,
      });
      assert.equal(localized.logPath, undefined);
      assert.equal(
        localized.logPathUnavailable,
        `remote daemon ${baseUrl}, request abc123: HTTP 404`,
      );
      assert.equal(JSON.stringify(localized).includes(DAEMON_LOG_PATH), false);
      assert.equal(
        fs.existsSync(path.join(stateDir, 'remote-diagnostics', 'cwd_9f1_default')),
        true,
        'the destination directory is created, but no partial record is left behind',
      );
      assert.equal(
        fs.existsSync(
          path.join(stateDir, 'remote-diagnostics', 'cwd_9f1_default', 'requests', 'abc123.ndjson'),
        ),
        false,
      );
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a daemon that names no record still never surfaces its own path', async () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-diagnostics-');
  try {
    const { diagnosticsRecord: _ref, ...withoutRef } = remoteError();
    const localized = await localizeRemoteDaemonError(withoutRef, {
      endpoint: { baseUrl: 'https://remote.example.test', token: 'daemon-secret' },
      stateDir,
      requestId: 'abc123',
    });
    assert.equal(localized.logPath, undefined);
    assert.equal(
      localized.logPathUnavailable,
      'remote daemon https://remote.example.test, request abc123: the daemon named no diagnostics record',
    );
    assert.equal(JSON.stringify(localized).includes(DAEMON_LOG_PATH), false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
