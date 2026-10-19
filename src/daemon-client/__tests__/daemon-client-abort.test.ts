import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import { createAgentDeviceClient } from '../../agent-device-client.ts';
import {
  createPublicWaitCommandSurface,
  startPublicDaemonRuntime,
} from '../../__tests__/test-utils/public-daemon-runtime.ts';
import { skipWhenLoopbackUnavailable, type SkippableTestContext } from '@agent-device/test-kit';

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function clientFor(stateDir: string, daemonTransport: 'socket' | 'http') {
  return createAgentDeviceClient({ stateDir, daemonTransport });
}

async function runAlreadyAborted(
  t: SkippableTestContext,
  daemonTransport: 'socket' | 'http',
): Promise<void> {
  if (await skipWhenLoopbackUnavailable(t)) return;
  let started = false;
  const daemon = await startPublicDaemonRuntime({
    createCommandSurface: createPublicWaitCommandSurface({
      onStarted: () => {
        started = true;
      },
    }),
  });
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      clientFor(daemon.stateDir, daemonTransport).command.wait({
        durationMs: 5_000,
        platform: 'macos',
        target: 'desktop',
        signal: controller.signal,
      }),
      (error: unknown) =>
        isRequestCanceledError(error) &&
        (error as { details?: Record<string, unknown> }).details?.dispatched === 'no',
    );
    assert.equal(started, false);
  } finally {
    await daemon.close();
  }
}

async function runAbortedInFlight(
  t: SkippableTestContext,
  daemonTransport: 'socket' | 'http',
): Promise<void> {
  if (await skipWhenLoopbackUnavailable(t)) return;
  let requestId: string | undefined;
  let canceled = false;
  const daemon = await startPublicDaemonRuntime({
    createCommandSurface: createPublicWaitCommandSurface({
      onStarted: (_target, startedRequestId) => {
        requestId = startedRequestId;
      },
      onCanceled: (_target, canceledRequestId) => {
        assert.equal(canceledRequestId, requestId);
        canceled = true;
      },
    }),
  });
  try {
    const client = clientFor(daemon.stateDir, daemonTransport);
    const controller = new AbortController();
    const inFlight = client.command.wait({
      durationMs: 5_000,
      platform: 'macos',
      target: 'desktop',
      signal: controller.signal,
    });
    await waitFor(() => requestId !== undefined, 'the daemon to start the request');
    controller.abort();

    const rejection = await inFlight.then(
      () => {
        throw new Error('expected the aborted call to reject');
      },
      (error: unknown) => error,
    );
    assert.equal(isRequestCanceledError(rejection), true);
    const details = (rejection as { details?: Record<string, unknown> }).details ?? {};
    assert.equal(details.dispatched, 'unknown');
    assert.equal(details.requestId, requestId);
    await waitFor(() => canceled, 'the daemon to observe cancellation');

    await expectQuickWait(client);
  } finally {
    await daemon.close();
  }
}

async function expectQuickWait(client: ReturnType<typeof createAgentDeviceClient>): Promise<void> {
  await expectWaitResult(
    client.command.wait({ durationMs: 1, platform: 'macos', target: 'desktop' }),
  );
}

async function expectWaitResult(result: Promise<unknown>): Promise<void> {
  assert.deepEqual(await result, { waitedMs: 1 });
}

test('socket transport refuses an already-aborted call without dispatching it', async (t) => {
  await runAlreadyAborted(t, 'socket');
});

test('socket transport cancels an in-flight request and serves a follow-up call', async (t) => {
  await runAbortedInFlight(t, 'socket');
});

test('HTTP transport refuses an already-aborted call without dispatching it', async (t) => {
  await runAlreadyAborted(t, 'http');
});

test('HTTP transport cancels an in-flight request and serves a follow-up call', async (t) => {
  await runAbortedInFlight(t, 'http');
});
