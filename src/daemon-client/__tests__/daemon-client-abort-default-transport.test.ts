import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import { createAgentDeviceClient } from '../../agent-device-client.ts';
import {
  createPublicWaitCommandSurface,
  startPublicDaemonRuntime,
} from '../../__tests__/test-utils/public-daemon-runtime.ts';
import { type SkippableTestContext, skipWhenLoopbackUnavailable } from '@agent-device/test-kit';

type SeenRequest = { started: boolean; canceled: boolean; requestId?: string };

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
  const seen: SeenRequest = { started: false, canceled: false };
  const daemon = await startPublicDaemonRuntime({
    createCommandSurface: createPublicWaitCommandSurface({
      onStarted: (_target, requestId) => {
        seen.started = true;
        seen.requestId = requestId;
      },
      onCanceled: () => {
        seen.canceled = true;
      },
    }),
  });
  try {
    const client = createAgentDeviceClient({
      stateDir: daemon.stateDir,
      daemonTransport: transport,
    });
    const controller = new AbortController();
    const call = client.command.wait({
      durationMs: 5_000,
      platform: 'macos',
      target: 'desktop',
      signal: controller.signal,
    });
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
    assert.equal(typeof details.requestId, 'string');
    assert.equal(details.dispatched, 'unknown');
    await waitFor(() => seen.canceled, 'the daemon to observe cancellation');
    assert.equal(seen.canceled, true);
    assert.equal(details.requestId, seen.requestId);
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
