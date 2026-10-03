import { test } from 'vitest';
import assert from 'node:assert/strict';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import { createRequestGuard } from './request-guard.ts';

function canceledOutcome(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (error: unknown) => error,
  );
}

test('a guard without a signal never refuses and never interferes', async () => {
  const guard = createRequestGuard({ signal: undefined, requestId: 'req-none' });
  guard.refuseIfAborted();
  assert.equal(await guard.guard(async () => 'sent'), 'sent');
});

test('refuseIfAborted refuses an already-aborted call with dispatched no', async () => {
  const controller = new AbortController();
  controller.abort(new Error('caller gave up'));
  const guard = createRequestGuard({ signal: controller.signal, requestId: 'req-pre' });
  assert.throws(
    () => guard.refuseIfAborted(),
    (error: unknown) =>
      isRequestCanceledError(error) &&
      (error as { details?: Record<string, unknown> }).details?.dispatched === 'no' &&
      (error as { details?: Record<string, unknown> }).details?.requestId === 'req-pre',
  );
});

test('guard settles an in-flight send with the typed canceled error whatever the abort reason', async () => {
  const controller = new AbortController();
  const guard = createRequestGuard({ signal: controller.signal, requestId: 'req-flight' });
  let settleSend: (() => void) | undefined;
  const pending = guard.guard(
    () => new Promise<string>((resolve) => (settleSend = () => resolve('late'))),
  );
  controller.abort(new Error('anything'));
  const error = await canceledOutcome(pending);
  assert.equal(isRequestCanceledError(error), true);
  assert.equal((error as { details?: Record<string, unknown> }).details?.dispatched, 'unknown');
  assert.equal((error as { details?: Record<string, unknown> }).details?.requestId, 'req-flight');
  // A transport that ignores the signal may still resolve later; that must not
  // turn the already-rejected caller promise into a second outcome.
  settleSend?.();
});

test('guard keeps a send error when no abort ever fires', async () => {
  const controller = new AbortController();
  const guard = createRequestGuard({ signal: controller.signal });
  const failure = new Error('daemon refused');
  await assert.rejects(
    guard.guard(async () => {
      throw failure;
    }),
    (error: unknown) => error === failure,
  );
});

test('guard returns the send value when it settles before any abort', async () => {
  const controller = new AbortController();
  const guard = createRequestGuard({ signal: controller.signal });
  const value = await guard.guard(async () => 'response');
  controller.abort();
  assert.equal(value, 'response');
});
