/**
 * #3178: the requester-side half of the per-call `AbortSignal`, owned by the transport module that
 * enforces the other half. These pin the guard's contract: what it refuses before sending
 * (`details.dispatched: 'no'`), what it answers when an abort lands while a send is outstanding
 * (`details.dispatched: 'unknown'`), and that the caller's own abort reason survives as the cause
 * whatever its shape — never as the rejection's reason, which always dispatches as
 * `request_canceled`.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import { createRequestGuard } from '../daemon-client-transport.ts';

function canceledOutcome(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (error: unknown) => error,
  );
}

function detailsOf(error: unknown): Record<string, unknown> {
  return (error as { details?: Record<string, unknown> }).details ?? {};
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
      detailsOf(error).dispatched === 'no' &&
      detailsOf(error).requestId === 'req-pre',
  );
});

test('a guard called with an already-aborted signal refuses before send with dispatched no', async () => {
  // Load-bearing branch: an abort listener attached to an already-aborted signal never fires, so
  // without this check the guard would pend forever instead of rejecting. The refusal also proves
  // `send` never ran, so the honest evidence is 'no' rather than 'unknown'.
  const controller = new AbortController();
  controller.abort();
  const guard = createRequestGuard({ signal: controller.signal, requestId: 'req-late' });
  const error = await canceledOutcome(
    guard.guard(async () => {
      throw new Error('send must not run');
    }),
  );
  assert.equal(isRequestCanceledError(error), true);
  assert.equal(detailsOf(error).dispatched, 'no');
  assert.equal(detailsOf(error).requestId, 'req-late');
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
  assert.equal(detailsOf(error).dispatched, 'unknown');
  assert.equal(detailsOf(error).requestId, 'req-flight');
  // A transport that ignores the signal may still resolve later; that must not
  // turn the already-rejected caller promise into a second outcome.
  settleSend?.();
});

test('guard keeps a non-Error abort reason as the cause unchanged', async () => {
  // `AbortController.abort()` accepts any value, and the helper promises the reason survives as
  // the cause: a bare string or a number must not be dropped for want of being an Error, while the
  // rejection itself still dispatches on request_canceled.
  for (const reason of ['gave-up', 42]) {
    const controller = new AbortController();
    controller.abort(reason);
    const guard = createRequestGuard({ signal: controller.signal });
    const error = await canceledOutcome(guard.guard(() => new Promise<string>(() => undefined)));
    assert.equal(isRequestCanceledError(error), true);
    assert.equal((error as { cause?: unknown }).cause, reason);
  }
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
