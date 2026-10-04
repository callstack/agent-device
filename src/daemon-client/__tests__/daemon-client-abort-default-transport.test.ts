/**
 * #3178: the real client route, through the default transport.
 *
 * `daemon-client-abort.test.ts` drives `sendRequest` directly, and `client-abort-signal.test.ts`
 * injects a fake transport, so neither proves that the caller's signal actually reaches the
 * transport from `createAgentDeviceClient`. That property lives at one line — the signal handed to
 * `sendRequest` in `daemon-client.ts` — and a test that skips that wiring cannot see it disappear:
 * delete the hand-off and a fake-transport test still passes, because the client-level guard
 * rejects the caller with `request_canceled` while the daemon keeps running the command on the
 * device. That is exactly the bug #3178 reports.
 *
 * Each case builds a client with NO injected transport, points its state dir at a loopback daemon
 * (a real `createSocketServer` / `createDaemonHttpServer` published through `daemon.json`), aborts
 * a long `wait` mid-flight, and asserts the DAEMON observed the cancellation — plus that the id in
 * the caller's rejection is the id the daemon canceled, which is what lets a caller correlate a
 * canceled call with the daemon's own diagnostics.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import { getRequestSignal, isRequestCanceled } from '@agent-device/host-kit/request';
import { readProcessStartTime } from '@agent-device/host-kit/process';
import { readVersion } from '@agent-device/host-kit/version';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from '../../daemon/daemon-request.ts';
import { createDaemonHttpServer } from '../../daemon/server/http-server.ts';
import { createSocketServer, listenNetServer } from '../../daemon/server/transport.ts';
import { createAgentDeviceClient } from '../../agent-device-client.ts';
import { currentDaemonCodeSignature } from '../../__tests__/test-utils/daemon-http-fixture.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
  trackLoopbackSockets,
  type SkippableTestContext,
} from '../../__tests__/test-utils/loopback.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

const TOKEN = 'default-transport-abort-token';

type SeenRequest = { started: boolean; canceled: boolean[]; requestId?: string };

// `wait` is the long request the caller abandons; it never answers on its own, so only the client's
// disconnect ends it — through the daemon's own request-scoped cancellation.
function hangingWaitHandler(seen: SeenRequest): DaemonInvokeFn {
  return async (req: DaemonRequest): Promise<DaemonResponse> => {
    const requestId = req.meta?.requestId;
    seen.started = true;
    seen.requestId = requestId;
    const signal = getRequestSignal(requestId);
    if (!signal) {
      return { ok: true, data: { answeredWithoutSignal: true } };
    }
    return await new Promise<DaemonResponse>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          seen.canceled.push(isRequestCanceled(requestId));
          reject(signal.reason);
        },
        { once: true },
      );
    });
  };
}

// The `daemon.json` a running daemon publishes, shaped so the client's takeover ladder reuses it:
// matching version and code signature, then the live probe the loopback server answers.
function publishLoopbackDaemonInfo(stateDir: string, info: Record<string, unknown>): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    `${stateDir}/daemon.json`,
    `${JSON.stringify({
      token: TOKEN,
      pid: process.pid,
      version: readVersion(),
      codeSignature: currentDaemonCodeSignature(),
      processStartTime: readProcessStartTime(process.pid) ?? undefined,
      ...info,
    })}\n`,
  );
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runDefaultTransportAbort(
  t: SkippableTestContext,
  transport: 'socket' | 'http',
  serve: (handleRequest: DaemonInvokeFn) => Promise<{
    server: Parameters<typeof closeLoopbackServer>[0];
    port: number;
    destroyConnections?: () => void;
  }>,
): Promise<void> {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const seen: SeenRequest = { started: false, canceled: [] };
  const stateDir = mkdtempForTestSync(`agent-device-abort-default-${transport}-`);
  const { server, port, destroyConnections } = await serve(hangingWaitHandler(seen));
  try {
    publishLoopbackDaemonInfo(
      stateDir,
      transport === 'socket'
        ? { port, transport: 'socket' }
        : { httpPort: port, transport: 'http' },
    );
    // No injected transport: the client's own `sendToDaemon` and default transport have to carry the
    // caller signal all the way to the connection they open.
    const client = createAgentDeviceClient({ stateDir, daemonTransport: transport });
    const controller = new AbortController();

    const call = client.command.wait({ durationMs: 5000, signal: controller.signal });
    await waitFor(() => seen.started, 'the daemon to start the request');
    controller.abort();

    const rejection = await call.then(
      () => {
        throw new Error('expected the aborted call to reject');
      },
      (error: unknown) => error,
    );
    assert.equal(isRequestCanceledError(rejection), true);
    const details = (rejection as { details?: Record<string, unknown> }).details ?? {};
    assert.equal(details.dispatched, 'unknown');
    // The proof the fake-transport tests cannot offer: the cancellation crossed the wire, because
    // the daemon's own request registry saw it. Delete the signal hand-off in `daemon-client.ts`
    // and this stays empty while the caller still rejects through its guard — the #3178 bug.
    await waitFor(() => seen.canceled.length > 0, 'daemon-side cancellation');
    assert.deepEqual(seen.canceled, [true]);
    // The caller's rejection names the same request the daemon canceled, so a caller can correlate
    // the two records.
    assert.equal(typeof details.requestId, 'string');
    assert.equal(details.requestId, seen.requestId);
  } finally {
    destroyConnections?.();
    await closeLoopbackServer(server);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

test('the default socket transport carries the caller signal: the daemon cancels the request the client aborted', async (t) => {
  await runDefaultTransportAbort(t, 'socket', async (handleRequest) => {
    const server = createSocketServer(handleRequest);
    // A canceled request's connection is destroyed by the client, but if an assertion above fails
    // before that, the handler waits forever on an open connection and `net.Server.close()` would
    // never return. Destroying the tracked sockets turns that into the failed assertion it is.
    const destroyConnections = trackLoopbackSockets(server);
    return { server, port: await listenNetServer(server), destroyConnections };
  });
});

test('the default HTTP transport carries the caller signal: the daemon cancels the request the client aborted', async (t) => {
  await runDefaultTransportAbort(t, 'http', async (handleRequest) => {
    const server = await createDaemonHttpServer({ handleRequest, token: TOKEN });
    return { server, port: await listenOnLoopback(server) };
  });
});
