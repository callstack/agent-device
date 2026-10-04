/**
 * #3178: every client call accepts `signal?: AbortSignal`.
 *
 * These pin the client's own half of the contract against a scripted transport: an already-aborted
 * call never reaches the transport (`details.dispatched: 'no'`), the signal rides the transport
 * context for a transport that honors it, and a custom transport that ignores the signal still
 * loses the race — the caller's promise rejects with the typed canceled-request error
 * (`details.dispatched: 'unknown'`). The transport-into-daemon half is covered by
 * `src/daemon-client/__tests__/daemon-client-abort.test.ts`.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import type { AgentDeviceDaemonTransportContext } from '@agent-device/contracts/client';
import type { DaemonRequest, DaemonResponse } from '@agent-device/kernel/contracts';
import { createTransport } from './client-transport-fixture.ts';

function canceledWith(error: unknown, dispatched: 'no' | 'unknown'): boolean {
  return (
    isRequestCanceledError(error) &&
    (error as { details?: Record<string, unknown> }).details?.dispatched === dispatched
  );
}

test('a client call with an already-aborted signal never reaches the transport', async () => {
  const { config, calls, transport } = createTransport(() => ({ ok: true, data: {} }));
  const client = createAgentDeviceClient(config, { transport });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    client.interactions.press({ ref: '@e12', signal: controller.signal }),
    (error: unknown) => canceledWith(error, 'no'),
  );
  assert.deepEqual(calls, []);
});

test('the signal rides the transport context so a built-in-style transport can close the request', async () => {
  const contexts: Array<AgentDeviceDaemonTransportContext | undefined> = [];
  const client = createAgentDeviceClient(
    {},
    {
      transport: async (_req, context) => {
        contexts.push(context);
        return { ok: true, data: {} } satisfies DaemonResponse;
      },
    },
  );
  const controller = new AbortController();
  await client.command.wait({ durationMs: 1, signal: controller.signal });
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0]?.signal, controller.signal);
});

test('aborting a call whose transport ignores the signal still rejects the caller with the typed canceled error', async () => {
  let lingering: ReturnType<typeof setTimeout> | undefined;
  const client = createAgentDeviceClient(
    {},
    {
      transport: (req) =>
        new Promise<DaemonResponse>((resolve) => {
          // A custom transport that never inspects the context signal: the guard must still settle
          // the caller's promise when the abort fires. The late resolve is cleared once the caller
          // has been rejected, so the worker keeps no timer alive for its own promise.
          lingering = setTimeout(
            () => resolve({ ok: true, data: { ignored: req.command } }),
            10_000,
          );
          lingering.unref?.();
        }),
    },
  );
  const controller = new AbortController();
  const call = client.interactions.press({ ref: '@e12', signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(call, (error: unknown) => canceledWith(error, 'unknown'));
  if (lingering) clearTimeout(lingering);
});

test('a signal on one call does not cancel another', async () => {
  const client = createAgentDeviceClient(
    {},
    {
      transport: async (req: Omit<DaemonRequest, 'token'>) => {
        if (req.command === 'wait') {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return { ok: true, data: {} };
      },
    },
  );
  const canceled = new AbortController();
  const doomed = client.command.wait({ durationMs: 5000, signal: canceled.signal });
  const survivor = client.command.wait({ durationMs: 1 });
  // Deferred so the doomed call is genuinely in flight when the abort fires: a synchronous abort
  // would land before `execute` installs the guard and reject through the pre-abort `no` path that
  // the first test already covers. The guard answers for a transport that ignores the signal, so
  // this exercises the in-flight `unknown` rejection while the survivor runs untouched.
  await new Promise((resolve) => setTimeout(resolve, 10));
  canceled.abort();
  await assert.rejects(doomed, (error: unknown) => canceledWith(error, 'unknown'));
  assert.deepEqual(await survivor, {});
});
