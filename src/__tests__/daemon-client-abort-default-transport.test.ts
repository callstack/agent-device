import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import { createAgentDeviceClient } from '@agent-device/client';
import { startPublicDaemonRuntime } from './test-utils/public-daemon-runtime.ts';
import { getRequestSignal } from '@agent-device/host-kit/request';
import { type SkippableTestContext, skipWhenLoopbackUnavailable } from '@agent-device/test-kit';

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runDefaultTransportAbort(
  t: SkippableTestContext,
  transport: 'socket' | 'http',
): Promise<void> {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const requestId = `default-transport-${transport}`;
  const daemon = await startPublicDaemonRuntime();
  try {
    const client = createAgentDeviceClient({
      stateDir: daemon.stateDir,
      daemonTransport: transport,
    });
    const controller = new AbortController();
    const call = client.command.wait({
      durationMs: 5_000,
      requestId,
      platform: 'macos',
      target: 'desktop',
      signal: controller.signal,
    });
    const settled = call.then(
      () => {
        throw new Error('expected the aborted call to reject');
      },
      (error: unknown) => error,
    );
    let daemonSignal: AbortSignal | undefined;
    await waitFor(() => {
      daemonSignal = daemon.runtime.run(() => getRequestSignal(requestId));
      return daemonSignal !== undefined;
    }, 'the daemon to admit the request');
    controller.abort();
    const rejection = await settled;
    assert.equal(isRequestCanceledError(rejection), true);
    const details = (rejection as { details?: Record<string, unknown> }).details ?? {};
    assert.equal(typeof details.requestId, 'string');
    assert.equal(details.dispatched, 'unknown');
    await waitFor(() => daemonSignal?.aborted === true, 'the daemon to observe cancellation');
    assert.equal(isRequestCanceledError(daemonSignal?.reason), true);
    await waitFor(
      () => daemon.runtime.run(() => getRequestSignal(requestId)) === undefined,
      'the daemon to finish the canceled request',
    );
    assert.equal(details.requestId, requestId);
  } finally {
    await daemon.close();
  }
}

test('the default socket transport carries the caller signal through the public daemon runtime', async (t) => {
  await runDefaultTransportAbort(t, 'socket');
});

test('the default HTTP transport carries the caller signal through the public daemon runtime', async (t) => {
  await runDefaultTransportAbort(t, 'http');
});
