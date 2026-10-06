// Source-mirroring coverage for the post-timeout liveness probe (#3177) — the question that
// authorizes (or refuses) a daemon reset. `daemon-client-timeout-route.test.ts` drives the route
// through `sendRequest`; this file pins the probe's own verdicts, budget, and wire request, which
// the route tests exercise only one endpoint at a time. Stand-ins answer or refuse immediately;
// only the tests that need a SILENT endpoint (the regressions the concurrent-legs design and the
// absolute deadline exist for) spend wall-clock, and each stays inside the unit budget.

import net from 'node:net';
import http from 'node:http';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { resolveCommandTimeoutPolicy } from '@agent-device/command-registry/registry';
import { loadNodeHttpRequester } from '@agent-device/host-kit/transport';
import {
  LIVENESS_PROBE_BUDGET_MS,
  probeDaemonResponsive,
} from '../daemon-client-liveness-probe.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
  type LoopbackServer,
} from '../../__tests__/test-utils/loopback.ts';

function daemonInfo(over: { port?: number; httpPort?: number }): {
  port?: number;
  httpPort?: number;
  token: string;
  pid: number;
} {
  return { ...over, token: 'test-token', pid: process.pid };
}

async function withLoopback<T>(
  server: LoopbackServer,
  run: (port: number) => Promise<T>,
): Promise<T> {
  const port = await listenOnLoopback(server);
  try {
    return await run(port);
  } finally {
    await closeLoopbackServer(server);
  }
}

test('the probe budget stays an order of magnitude under the narrowest reset-eligible envelope', () => {
  // A timed-out reset-eligible request may pay one extra probe window before its error lands.
  // The narrowest envelope that class carries is the registry default (90s): keep the probe a
  // rounding error against it, so the probe never dominates the operation it follows (AGENTS.md
  // probe rule). If someone widens the probe toward the envelope, this fails at the owning number.
  const narrowestResetEligibleEnvelopeMs = resolveCommandTimeoutPolicy(
    PUBLIC_COMMANDS.open,
  ).envelopeMs;
  assert.equal(typeof narrowestResetEligibleEnvelopeMs, 'number');
  assert.ok(
    LIVENESS_PROBE_BUDGET_MS * 10 <= (narrowestResetEligibleEnvelopeMs as number),
    `probe budget ${LIVENESS_PROBE_BUDGET_MS}ms must stay 10x under the ${narrowestResetEligibleEnvelopeMs}ms envelope`,
  );
});

test('a daemon answering /health is responsive', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  // The url is asserted, not just "an answer": a probe that drifted to any other route would
  // still be answered by a server that answers everything, and the finding would then describe
  // some other endpoint's liveness rather than the health route the transport also asks.
  const requestedUrls: string[] = [];
  const server = http.createServer((req, res) => {
    requestedUrls.push(String(req.url));
    res.statusCode = 200;
    res.end('{}');
  });
  await withLoopback(server, async (port) => {
    assert.equal(await probeDaemonResponsive(daemonInfo({ httpPort: port })), true);
    assert.deepEqual(requestedUrls, ['/health']);
  });
});

test('a 5xx answer is still an answer: the finding is liveness, not reachability policy', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  // `readDaemonHttpHealth` (the reachability reader the transport uses before each command) reports
  // a 5xx as UNREACHABLE — correct for its own policy, wrong for this one. The probe asks only
  // whether the endpoint answered, so a daemon serving a 500 is alive and must not be killed:
  // reading a reachability flag here would reproduce the bug #3177 is about.
  const server = http.createServer((_req, res) => {
    res.statusCode = 503;
    res.end('overloaded');
  });
  await withLoopback(server, async (port) => {
    assert.equal(await probeDaemonResponsive(daemonInfo({ httpPort: port })), true);
  });
});

test('headers alone answer: a daemon that stalls mid-body is still served', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  // The finding is "the event loop served a fresh request", and that is already proven by a status
  // line. A reader that waits for the whole BODY would call a daemon which answers and then stalls
  // mid-response silent — the negative verdict would reset a live shared daemon, which is the bug
  // #3177 is about. (A body-reading health helper does exactly that for its own purposes; the probe
  // must not borrow it.) So the affirmative must arrive by the deadline's FIRST fraction, not at it.
  const stallingBodyServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-length': '1000' });
    // Node buffers headers with the first chunk, so this is what makes the status line actually
    // reach the client. The declared body is never sent: headers delivered, body pending forever.
    res.flushHeaders();
    res.on('error', () => {});
  });
  await withLoopback(stallingBodyServer, async (port) => {
    const startedAt = Date.now();
    assert.equal(
      await probeDaemonResponsive(daemonInfo({ httpPort: port })),
      true,
      'a stalled body must not be read as an unresponsive daemon',
    );
    assert.ok(
      Date.now() - startedAt < LIVENESS_PROBE_BUDGET_MS / 2,
      'the answer is headers-arrival, not the deadline running out',
    );
  });
});

test('the health leg rides a fresh connection, never the keep-alive pool', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  // Since Node 19 `http.globalAgent` has `keepAlive: true`, so a default request can REUSE an idle
  // socket from an earlier command's health read. Reuse would make "did this probe connect?" a
  // question about a socket this probe never opened — and a pooled socket the daemon had half torn
  // down would answer silent, resetting a live daemon. Discriminator: on a reused connection the
  // server sees the SAME socket object for both requests, so `clientSockets.size` is 1 for reuse
  // and 2 for a fresh connection. The prime must use the SAME module object the probe loads
  // (`loadNodeHttpRequester('http:')` resolves the real `node:http`) or the pool holds no candidate
  // and the test proves nothing.
  // `keepAlive` is set at runtime (Node >=19) but not on the base `Agent` type.
  if (!(http.globalAgent as { keepAlive?: boolean }).keepAlive) return; // pool cannot prime without keep-alive
  const clientSockets = new Set<net.Socket>();
  let probeRequests = 0;
  let primed = false;
  const server = http.createServer((req, res) => {
    clientSockets.add(req.socket);
    req.socket.on('error', () => {});
    if (primed) probeRequests += 1;
    else primed = true;
    res.end('{}');
  });
  const httpRequester = await loadNodeHttpRequester('http:');
  await withLoopback(server, async (port) => {
    // Prime: a full keep-alive request/response whose socket returns to the global pool.
    await new Promise<void>((resolve, reject) => {
      const request = httpRequester.request(
        { host: '127.0.0.1', port, path: '/health', method: 'GET' },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      request.on('error', reject);
      request.end();
    });
    assert.equal(clientSockets.size, 1, 'the prime must have connected');
    assert.equal(await probeDaemonResponsive(daemonInfo({ httpPort: port })), true);
    assert.equal(probeRequests, 1, 'the health leg must actually have been asked');
    assert.equal(
      clientSockets.size,
      2,
      'the probe rode the primed keep-alive socket instead of opening a fresh connection',
    );
  });
});

test('a refused endpoint is negative, not a hang: the verdict arrives well inside the budget', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  // The wedged-daemon shape: connections are accepted and destroyed without an answer. The
  // negative verdict must come from the refusal itself (fast), not from waiting out the window —
  // a timeout error's latency must not depend on the probe budget when the host already answered.
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.destroy();
  });
  await withLoopback(server, async (port) => {
    const startedAt = Date.now();
    assert.equal(await probeDaemonResponsive(daemonInfo({ port })), false);
    assert.ok(
      Date.now() - startedAt < LIVENESS_PROBE_BUDGET_MS / 2,
      'refusal must settle the probe immediately, not by spending the window',
    );
  });
});

test('a silent HTTP leg cannot veto a live socket leg', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  // The regression the concurrent-legs design exists for: sequential probing lets the first
  // endpoint spend the whole budget (a transport that accepts but never answers), leaving the
  // second endpoint no window — and the all-negative verdict SIGKILLs a daemon the other
  // transport would have proven alive. The wrong verdict here kills every session on the host,
  // which is the bug #3177 is about.
  // The HTTP leg must be OBSERVED, not assumed: a verdict reached with no /health request ever
  // sent would also pass if the probe simply skipped the leg. So the socket waits for the receipt
  // before it answers — if the HTTP leg never asks, the socket never answers, the probe spends
  // its window, and the `true` assertion below fails for the right reason.
  const healthRequested: { value: boolean } = { value: false };
  const rpcHangingServer = http.createServer((req, res) => {
    if (req.url === '/health') healthRequested.value = true;
    // Accepts and never answers: this leg will spend the full budget.
    res.on('error', () => {});
  });
  const liveSocketServer = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.on('data', () => {
      const answer = () => {
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'probe', result: { ok: true } })}\n`);
      };
      const waitForHttpLeg = (): void => {
        if (healthRequested.value) answer();
        else setTimeout(waitForHttpLeg, 5);
      };
      waitForHttpLeg();
    });
  });
  const httpPort = await listenOnLoopback(rpcHangingServer);
  try {
    await withLoopback(liveSocketServer, async (port) => {
      const startedAt = Date.now();
      assert.equal(
        await probeDaemonResponsive(daemonInfo({ port, httpPort })),
        true,
        'the socket answer alone is the finding; the silent HTTP leg must not outweigh it',
      );
      assert.ok(healthRequested.value, 'a verdict with no request on the HTTP leg skipped the leg');
      assert.ok(
        Date.now() - startedAt < LIVENESS_PROBE_BUDGET_MS,
        'the affirmative short-circuits instead of waiting the silent leg out',
      );
    });
  } finally {
    await closeLoopbackServer(rpcHangingServer);
  }
});

// `readDaemonInfo` accepts any positive integer port, and BOTH transports throw synchronously on
// one out of range (`ERR_SOCKET_BAD_PORT`). The HTTP leg builds detached, so its throw would
// surface as an unhandled rejection; the socket leg builds synchronously, so its throw would
// escape `probeDaemonResponsive` altogether — replacing the caller's timeout error with a crash
// from the recovery path and discarding the other leg's answer.
async function expectMalformedLegAnswersNotThisOne(
  info: Parameters<typeof probeDaemonResponsive>[0],
  expectResponsive: boolean,
  name: string,
): Promise<void> {
  const probe = probeDaemonResponsive(info);
  const rejection = probe.then(
    () => null,
    (error: unknown) => error,
  );
  assert.equal(await probe, expectResponsive, `${name}: the malformed leg answers 'not this one'`);
  assert.equal(await rejection, null, `${name}: the probe never rejects on a malformed record`);
}

// These two rows bind no listener at all: a loopback guard here would let an environment that
// cannot bind silently skip the socket-leg escape regression this file exists to hold.
test('a malformed port is an endpoint that did not answer, on either leg and never a crash', async () => {
  process.on('unhandledRejection', failFastOnUnhandledRejection);
  try {
    await expectMalformedLegAnswersNotThisOne(
      daemonInfo({ httpPort: 70_000 }),
      false,
      'http leg malformed',
    );
    await expectMalformedLegAnswersNotThisOne(
      daemonInfo({ port: 70_000 }),
      false,
      'socket leg malformed',
    );
  } finally {
    process.off('unhandledRejection', failFastOnUnhandledRejection);
  }
});

test('a malformed socket port does not discard the answer of a live HTTP peer', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const liveHttp = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.end('{}');
  });
  const httpPort = await listenOnLoopback(liveHttp);
  process.on('unhandledRejection', failFastOnUnhandledRejection);
  try {
    await expectMalformedLegAnswersNotThisOne(
      daemonInfo({ port: 70_000, httpPort }),
      true,
      'socket malformed alongside a live http peer',
    );
  } finally {
    process.off('unhandledRejection', failFastOnUnhandledRejection);
    await closeLoopbackServer(liveHttp);
  }
});
function failFastOnUnhandledRejection(error: unknown): never {
  throw error;
}

test('a slow-trickle endpoint is cut off by the absolute deadline, not extended by its dribble', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  // `socket.setTimeout`/`http.request({timeout})` are IDLE timeouts: a daemon that dribbles bytes
  // forever would keep the probe (and the caller's error) open indefinitely. The probe deadline
  // must be absolute, so a wedged-but-trickling endpoint still gets the negative verdict by
  // `LIVENESS_PROBE_BUDGET_MS`.
  // NB: a server-side socket never emits `connect`, so the dribble starts immediately on accept.
  // It must actually keep the client's IDLE timeout reset, or this test proves nothing about the
  // absolute deadline: an idle-only seam would pass this same assertion for a socket that simply
  // got nothing.
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.write('x');
    const dribble = setInterval(() => socket.write('x'), 20);
    socket.on('close', () => clearInterval(dribble));
  });
  await withLoopback(server, async (port) => {
    const startedAt = Date.now();
    assert.equal(await probeDaemonResponsive(daemonInfo({ port })), false);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(
      elapsedMs >= LIVENESS_PROBE_BUDGET_MS / 2 && elapsedMs <= LIVENESS_PROBE_BUDGET_MS * 1.5,
      `trickle must end at the deadline, measured ${elapsedMs}ms (budget ${LIVENESS_PROBE_BUDGET_MS}ms)`,
    );
  });
});

test('the socket probe asks with the session-lock-exempt inventory command', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  // The probe must never queue behind the session/device work that made the original request time
  // out. That is a registry claim (`sessionExecutionLockExempt`), verified here end-to-end at the
  // wire: the command on the probe's request line is the inventory one.
  let requestLine = '';
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', (chunk) => {
      requestLine = String(chunk);
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'p', result: { ok: true } })}\n`);
    });
  });
  await withLoopback(server, async (port) => {
    assert.equal(await probeDaemonResponsive(daemonInfo({ port }), { session: 'worker-3' }), true);
    const asked = JSON.parse(requestLine) as { command: string; session?: string };
    assert.equal(asked.command, 'session_list');
    assert.equal(asked.session, 'worker-3');
  });
});
