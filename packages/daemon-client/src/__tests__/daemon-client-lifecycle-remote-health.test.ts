// A remote connection probes GET /health before it sends anything. While that gate is closed the
// request never left the client, so the gate may re-probe a daemon that is there but not ready for
// the command's own budget, and its refusal is the typed one: a caller branches on `details.reason`
// and `details.dispatched` instead of comparing the message.

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
import { cachedRemoteDaemonHealth } from '../daemon-client-transport.ts';

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

/**
 * A remote daemon whose `/health` answers each status of `healthStatuses` in turn (the last one from
 * then on), and that counts the probes and RPCs it receives. Every RPC answers 500.
 */
function remoteWithHealthStatus(...healthStatuses: number[]): {
  handler: http.Server;
  healthProbes: () => number;
  rpcSends: () => number;
} {
  let healthProbes = 0;
  let rpcSends = 0;
  const handler = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url?.endsWith('/health')) {
        res.statusCode = healthStatuses[Math.min(healthProbes, healthStatuses.length - 1)]!;
        healthProbes += 1;
        res.end();
        return;
      }
      rpcSends += 1;
      res.statusCode = 500;
      res.end();
    });
  });
  return { handler, healthProbes: () => healthProbes, rpcSends: () => rpcSends };
}

test('a remote press whose health probe answers 5xx re-probes, then is sent exactly once', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { handler, healthProbes, rpcSends } = remoteWithHealthStatus(503, 200);
  const port = await listenOnLoopback(handler);
  try {
    await assert.rejects(
      sendToDaemon(remotePress(`http://127.0.0.1:${port}`)),
      (error: unknown) => {
        assert.ok(error instanceof AppError, `unexpected failure: ${String(error)}`);
        assert.equal(error.code, 'COMMAND_FAILED');
        assert.notEqual(error.details?.reason, REMOTE_DAEMON_UNAVAILABLE_REASON);
        assert.notEqual(error.details?.dispatched, 'no', 'the press left the client');
        return true;
      },
    );
    assert.equal(healthProbes(), 2, 'the gate re-probed once the daemon was back');
    // The press reached the daemon and failed there: a failure after dispatch is never resent.
    assert.equal(rpcSends(), 1);
  } finally {
    await closeLoopbackServer(handler);
  }
});

// A connection the host refuses outright found no daemon at all, which a wrong base URL looks like:
// it is refused on the first probe instead of waiting out the command's budget.
test('a remote press whose health probe is refused is refused at once with the typed reason', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const closed = http.createServer();
  const port = await listenOnLoopback(closed);
  await closeLoopbackServer(closed);
  const baseUrl = `http://127.0.0.1:${port}`;
  await assert.rejects(sendToDaemon(remotePress(baseUrl)), (error: unknown) => {
    assert.ok(error instanceof AppError, `unexpected failure: ${String(error)}`);
    assert.equal(error.code, 'COMMAND_FAILED');
    assert.equal(error.details?.reason, REMOTE_DAEMON_UNAVAILABLE_REASON);
    assert.equal(error.details?.dispatched, 'no');
    assert.equal(error.details?.daemonBaseUrl, baseUrl);
    assert.equal(error.details?.attempts, 1);
    return true;
  });
});

// A daemon that answered 503 and then refuses connections is gone, not restarting: the re-probe
// that is refused ends the wait at once instead of waiting out the command's budget.
test('a remote press re-probing after 5xx stops at the first refused connection', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const handler = http.createServer((req, res) => {
    req.resume();
    res.statusCode = 503;
    res.end();
    handler.close();
    handler.closeAllConnections();
  });
  const port = await listenOnLoopback(handler);
  try {
    await assert.rejects(
      sendToDaemon(remotePress(`http://127.0.0.1:${port}`)),
      (error: unknown) => {
        assert.ok(error instanceof AppError, `unexpected failure: ${String(error)}`);
        assert.equal(error.details?.reason, REMOTE_DAEMON_UNAVAILABLE_REASON);
        assert.equal(error.details?.dispatched, 'no');
        assert.equal(error.details?.attempts, 2);
        assert.equal(error.details?.healthRecoveryBudgetMs, undefined, 'the budget was not spent');
        return true;
      },
    );
  } finally {
    if (handler.listening) await closeLoopbackServer(handler);
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

/** A remote daemon whose `/health` answers 200 with an instance id after `delayMs`, counting probes. */
async function slowHealthyRemote(delayMs: number): Promise<{
  handler: http.Server;
  info: { baseUrl: string; token: string; pid: number };
  probes: () => number;
}> {
  let probes = 0;
  const handler = http.createServer((req, res) => {
    req.resume();
    probes += 1;
    setTimeout(() => {
      res.statusCode = 200;
      res.end(JSON.stringify({ instanceId: 'remote-instance' }));
    }, delayMs);
  });
  const port = await listenOnLoopback(handler);
  const info = { baseUrl: `http://127.0.0.1:${port}`, token: `probe-${port}`, pid: 0 };
  return { handler, info, probes: () => probes };
}

// A bounded caller never joins a probe another caller started: that probe runs on another budget,
// so waiting on it would spend this caller's budget on a stale request.
test('a bounded health caller runs its own probe instead of joining one in flight', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const remote = await slowHealthyRemote(300);
  try {
    const unbounded = cachedRemoteDaemonHealth(remote.info);
    const bounded = await cachedRemoteDaemonHealth(remote.info, 50);

    assert.equal(bounded.reachable, false);
    assert.equal(bounded.timedOut, true);
    assert.equal((await unbounded).reachable, true);
    assert.equal(remote.probes(), 2, 'the bounded caller sent its own probe');
    // The settled answer is cached, so a later bounded caller reads it without probing.
    assert.equal((await cachedRemoteDaemonHealth(remote.info, 50)).reachable, true);
    assert.equal(remote.probes(), 2);
  } finally {
    await closeLoopbackServer(remote.handler);
  }
});

// A caller already aborted, or with no budget left, sends no request at all.
test('an aborted or budgetless health caller sends no probe', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const remote = await slowHealthyRemote(0);
  try {
    assert.equal((await cachedRemoteDaemonHealth(remote.info, 0)).reachable, false);
    assert.equal(
      (await cachedRemoteDaemonHealth(remote.info, undefined, AbortSignal.abort())).reachable,
      false,
    );
    assert.equal(remote.probes(), 0);
  } finally {
    await closeLoopbackServer(remote.handler);
  }
});
