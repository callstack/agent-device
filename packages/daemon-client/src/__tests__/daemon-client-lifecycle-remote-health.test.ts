// A remote connection probes GET /health before it sends anything. When that probe answers nothing
// usable, the refusal is the typed one: the request never left the client, so a caller branches on
// `details.reason` and `details.dispatched` instead of comparing the message.

import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'vitest';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { REMOTE_DAEMON_UNAVAILABLE_REASON } from '../daemon-lifecycle-errors.ts';
import { sendToDaemon } from '../index.ts';

// A press, so the refusal states the fact a caller needs before resending a mutating command.
function remotePress(baseUrl: string) {
  return {
    session: 'default',
    command: PUBLIC_COMMANDS.press,
    positionals: ['@e1'],
    flags: { daemonBaseUrl: baseUrl },
    meta: { requestId: 'req-remote-health-refusal' },
  };
}

/** A remote daemon that answers `/health` with `healthStatus` and counts the RPCs it receives. */
function remoteWithHealthStatus(healthStatus: number): {
  handler: http.Server;
  rpcSends: () => number;
} {
  let rpcSends = 0;
  const handler = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url?.endsWith('/health')) {
        res.statusCode = healthStatus;
        res.end();
        return;
      }
      rpcSends += 1;
      res.statusCode = 500;
      res.end();
    });
  });
  return { handler, rpcSends: () => rpcSends };
}

test('a remote press whose health probe answers 5xx refuses with the typed reason and dispatched no', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { handler, rpcSends } = remoteWithHealthStatus(503);
  const port = await listenOnLoopback(handler);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await assert.rejects(sendToDaemon(remotePress(baseUrl)), (error: unknown) => {
      assert.ok(error instanceof AppError, `unexpected failure: ${String(error)}`);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.reason, REMOTE_DAEMON_UNAVAILABLE_REASON);
      assert.equal(error.details?.dispatched, 'no');
      assert.equal(error.details?.daemonBaseUrl, baseUrl);
      return true;
    });
    assert.equal(rpcSends(), 0, 'an unreachable remote daemon receives no RPC');
  } finally {
    await closeLoopbackServer(handler);
  }
});

// The closest negative: a probe that answers 4xx counts as reachable, so the press is sent and the
// unavailable refusal is never stamped on a request that left the client.
test('a remote press whose health probe answers 4xx is sent and is not the unavailable refusal', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { handler, rpcSends } = remoteWithHealthStatus(404);
  const port = await listenOnLoopback(handler);
  try {
    await assert.rejects(
      sendToDaemon(remotePress(`http://127.0.0.1:${port}`)),
      (error: unknown) => {
        assert.ok(error instanceof AppError, `unexpected failure: ${String(error)}`);
        assert.notEqual(error.details?.reason, REMOTE_DAEMON_UNAVAILABLE_REASON);
        return true;
      },
    );
    assert.equal(rpcSends(), 1);
  } finally {
    await closeLoopbackServer(handler);
  }
});
