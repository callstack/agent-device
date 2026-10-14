/**
 * A remote daemon's upload, artifact download and request diagnostics calls are plain HTTP, so
 * the lease they belong to cannot ride in an RPC body. These prove `sendToDaemon` names the held
 * lease on each of them in a header — what lets a gateway in front of many daemons route them —
 * and sends no such header when no lease is held.
 */

import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit/loopback';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { sendToDaemon } from '../daemon-client.ts';
import { DAEMON_HTTP_LEASE_HEADER } from '@agent-device/contracts/daemon-http';

const DAEMON_TOKEN = 'remote-secret';

type SeenRequest = { route: string; leaseHeader: string | undefined };

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function tempDir(prefix: string): string {
  const dir = mkdtempForTestSync(prefix);
  tempDirs.push(dir);
  return dir;
}

/**
 * A remote daemon fake: `install` succeeds after a legacy upload, `screenshot` returns one
 * downloadable artifact, and `clipboard` fails naming a diagnostics record. Every request other
 * than `/health` and `/rpc` is recorded with the lease header it carried.
 */
async function withRemoteDaemon(
  run: (baseUrl: string, seen: SeenRequest[]) => Promise<void>,
): Promise<void> {
  const seen: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const route = `${req.method} ${req.url}`;
      if (req.url === '/health') {
        res.statusCode = 200;
        res.end();
        return;
      }
      if (req.url !== '/rpc') {
        const leaseHeader = req.headers[DAEMON_HTTP_LEASE_HEADER];
        seen.push({
          route,
          leaseHeader: typeof leaseHeader === 'string' ? leaseHeader : undefined,
        });
      }
      res.setHeader('content-type', 'application/json');
      if (req.url === '/upload/preflight') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      if (req.url === '/upload') {
        res.end(JSON.stringify({ ok: true, uploadId: 'upload-1' }));
        return;
      }
      if (req.url?.startsWith('/artifacts/')) {
        res.end('png-bytes');
        return;
      }
      if (req.url?.endsWith('/diagnostics')) {
        res.end('{"phase":"request_failed"}\n');
        return;
      }
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        id: string;
        params?: { command?: string };
      };
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, ...rpcAnswer(rpc) }));
    });
  });
  try {
    const port = await listenOnLoopback(server);
    await run(`http://127.0.0.1:${port}`, seen);
  } finally {
    await closeLoopbackServer(server);
  }
}

function rpcAnswer(rpc: { id: string; params?: { command?: string } }): Record<string, unknown> {
  if (rpc.params?.command === 'screenshot') {
    return {
      result: {
        ok: true,
        data: {
          artifacts: [{ field: 'path', artifactId: 'shot-1', fileName: 'shot.png' }],
        },
      },
    };
  }
  if (rpc.params?.command === 'clipboard') {
    return {
      error: {
        message: 'clipboard failed',
        data: {
          code: 'COMMAND_FAILED',
          message: 'clipboard failed',
          diagnosticsRecord: { session: 'default', requestId: rpc.id },
        },
      },
    };
  }
  return { result: { ok: true, data: {} } };
}

async function sendRemote(
  baseUrl: string,
  request: {
    command: string;
    positionals: string[];
    flags?: Record<string, unknown>;
  },
  leaseId: string | undefined,
): Promise<void> {
  await sendToDaemon(
    {
      session: 'default',
      command: request.command,
      positionals: request.positionals,
      flags: {
        platform: 'android',
        daemonBaseUrl: baseUrl,
        stateDir: tempDir('agent-device-lease-header-state-'),
        ...request.flags,
      },
      meta: {
        requestId: `req-${request.command}`,
        ...(leaseId ? { leaseId } : {}),
      },
    } as Parameters<typeof sendToDaemon>[0],
    { authToken: DAEMON_TOKEN },
  ).catch((error: unknown) => {
    // `clipboard` fails on purpose; only its diagnostics fetch is under test.
    if (request.command !== 'clipboard') throw error;
  });
}

async function runEveryRequestKind(leaseId: string | undefined): Promise<SeenRequest[]> {
  let observed: SeenRequest[] = [];
  await withRemoteDaemon(async (baseUrl, seen) => {
    const apkPath = path.join(tempDir('agent-device-lease-header-apk-'), 'app.apk');
    fs.writeFileSync(apkPath, 'apk-bytes');
    const screenshotPath = path.join(tempDir('agent-device-lease-header-shot-'), 'shot.png');

    await sendRemote(baseUrl, { command: 'install', positionals: [apkPath] }, leaseId);
    await sendRemote(baseUrl, { command: 'screenshot', positionals: [screenshotPath] }, leaseId);
    await sendRemote(baseUrl, { command: 'clipboard', positionals: ['read'] }, leaseId);
    assert.equal(fs.readFileSync(screenshotPath, 'utf8'), 'png-bytes');
    observed = seen;
  });
  return observed;
}

test('a remote upload, artifact download and diagnostics fetch name the held lease', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const seen = await runEveryRequestKind('lease-1');
  assert.deepEqual(seen, [
    { route: 'POST /upload/preflight', leaseHeader: 'lease-1' },
    { route: 'POST /upload', leaseHeader: 'lease-1' },
    { route: 'GET /artifacts/shot-1', leaseHeader: 'lease-1' },
    {
      route: 'GET /sessions/default/requests/req-clipboard/diagnostics',
      leaseHeader: 'lease-1',
    },
  ]);
});

test('a remote upload, artifact download and diagnostics fetch send no lease header without a lease', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const seen = await runEveryRequestKind(undefined);
  assert.deepEqual(seen, [
    { route: 'POST /upload/preflight', leaseHeader: undefined },
    { route: 'POST /upload', leaseHeader: undefined },
    { route: 'GET /artifacts/shot-1', leaseHeader: undefined },
    {
      route: 'GET /sessions/default/requests/req-clipboard/diagnostics',
      leaseHeader: undefined,
    },
  ]);
});
