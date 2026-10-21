import { test, vi } from 'vitest';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import assert from 'node:assert/strict';
import {
  AppError,
  createRequestCanceledError,
  isRequestCanceledError,
} from '@agent-device/kernel/errors';
import {
  clearRequestAbortRegistration,
  markRequestCanceled,
  registerRequestAbort,
  resolveRequestTrackingId,
  getRequestSignal,
  throwIfRequestCanceled,
  withRequestDeadline,
} from './request-cancel.ts';

test('resolveRequestTrackingId generates unique ids for fallback seeds', () => {
  const first = resolveRequestTrackingId(undefined, 42);
  const second = resolveRequestTrackingId(undefined, 42);
  assert.match(first, /^req:42:/);
  assert.match(second, /^req:42:/);
  assert.notEqual(first, second);
});

test('daemon deadline cancels in-flight work with its typed reason and retains registration until settlement', async () => {
  vi.useFakeTimers();
  const registration = registerRequestAbort('deadline');
  try {
    const signal = getRequestSignal('deadline')!;
    let finish!: () => void;
    const task = withRequestDeadline('deadline', 60_000, async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      throw new Error('transport aborted without a response');
    });
    const rejected = assert.rejects(
      task,
      (error: unknown) =>
        error instanceof AppError &&
        error.details?.reason === 'daemon_request_timeout' &&
        error.details.timeoutMs === 60_000,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    assert.equal(signal.aborted, true);
    assert.equal(isRequestCanceledError(signal.reason), true);
    assert.equal(getRequestSignal('deadline'), signal);
    finish();
    await rejected;
    assert.equal(getRequestSignal('deadline'), signal);
  } finally {
    clearRequestAbortRegistration(registration);
    vi.useRealTimers();
  }
});

test('a completed daemon deadline releases its timer and preserves later cancellation', async () => {
  vi.useFakeTimers();
  const registration = registerRequestAbort('completed-deadline');
  try {
    const response: DaemonResponse = { ok: true, data: { completed: true } };
    assert.equal(
      await withRequestDeadline('completed-deadline', 100, async () => response),
      response,
    );
    await vi.advanceTimersByTimeAsync(100);
    assert.equal(getRequestSignal('completed-deadline')?.aborted, false);
    markRequestCanceled('completed-deadline');
    assert.throws(() => throwIfRequestCanceled('completed-deadline'), isRequestCanceledError);
  } finally {
    clearRequestAbortRegistration(registration);
    vi.useRealTimers();
  }
});

test.each(['timer', 'wall-clock'])(
  'a late completed response stays successful after the %s deadline',
  async (clock) => {
    vi.useFakeTimers();
    try {
      const response: DaemonResponse = {
        ok: true,
        data: { executed: 3, results: ['press', 'fill', 'longpress'] },
      };
      const result = await withRequestDeadline('late-success', 100, async () => {
        if (clock === 'timer') await vi.advanceTimersByTimeAsync(101);
        else vi.setSystemTime(Date.now() + 101);
        return response;
      });
      assert.equal(result, response);
      assert.equal(getRequestSignal('late-success'), undefined);
    } finally {
      vi.useRealTimers();
    }
  },
);

test('deadline failure retains response diagnostics and progress while adding timeout metadata', async () => {
  vi.useFakeTimers();
  try {
    const response: DaemonResponse = {
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: 'Batch failed at step 3',
        hint: 'Inspect the failed step',
        diagnosticId: 'diag-3',
        logPath: '/tmp/request.log',
        retriable: false,
        details: {
          executed: 2,
          partialResults: [{ command: 'press' }, { command: 'fill' }],
          dispatched: 'unknown',
          reason: 'transport_aborted',
        },
      },
    };
    const result = await withRequestDeadline('failed-response', 100, async () => {
      await vi.advanceTimersByTimeAsync(100);
      return response;
    });
    assert.equal(result.ok, false);
    if (result.ok) assert.fail('deadline failure became a success');
    assert.equal(result.error.code, 'COMMAND_FAILED');
    assert.equal(result.error.message, 'Batch failed at step 3');
    assert.equal(result.error.hint, 'Inspect the failed step');
    assert.equal(result.error.diagnosticId, 'diag-3');
    assert.equal(result.error.logPath, '/tmp/request.log');
    assert.equal(result.error.retriable, false);
    assert.equal(result.error.details?.executed, 2);
    assert.deepEqual(result.error.details?.partialResults, [
      { command: 'press' },
      { command: 'fill' },
    ]);
    assert.equal(result.error.details?.dispatched, 'unknown');
    assert.equal(result.error.details?.reason, 'daemon_request_timeout');
    assert.equal(result.error.details?.causeReason, 'transport_aborted');
    assert.equal(result.error.details?.timeoutMs, 100);
  } finally {
    vi.useRealTimers();
  }
});

test('deadline projection replaces cancellation copy while keeping completed-step evidence', async () => {
  vi.useFakeTimers();
  try {
    const result = await withRequestDeadline('cancel-copy', 100, async () => {
      await vi.advanceTimersByTimeAsync(100);
      return {
        ok: false,
        error: {
          code: 'COMMAND_FAILED',
          message: 'request canceled',
          hint: 'The request was canceled intentionally',
          details: {
            reason: 'request_canceled',
            executed: 1,
            partialResults: [{ command: 'press' }],
            source: { path: '/tmp/workflow.ad', line: 3 },
          },
        },
      } satisfies DaemonResponse;
    });
    assert.equal(result.ok, false);
    if (result.ok) assert.fail('deadline failure became a success');
    assert.equal(result.error.message, 'Daemon request deadline exceeded');
    assert.doesNotMatch(String(result.error.hint), /canceled intentionally/);
    assert.deepEqual(result.error.details?.partialResults, [{ command: 'press' }]);
    assert.deepEqual(result.error.details?.source, { path: '/tmp/workflow.ad', line: 3 });
    assert.equal(result.error.details?.executed, 1);
    assert.equal(result.error.details?.causeReason, 'request_canceled');
    assert.equal(result.error.details?.reason, 'daemon_request_timeout');
  } finally {
    vi.useRealTimers();
  }
});

test('a thrown error before the deadline retains its identity', async () => {
  const error = new AppError('INVALID_ARGS', 'Invalid replay');
  await assert.rejects(
    withRequestDeadline('early-throw', 100, async () => {
      throw error;
    }),
    (caught) => caught === error,
  );
});

test('a deadline after a thrown cancellation preserves its cause and progress', async () => {
  vi.useFakeTimers();
  try {
    await assert.rejects(
      withRequestDeadline('thrown-progress', 100, async () => {
        await vi.advanceTimersByTimeAsync(100);
        throw new AppError('COMMAND_FAILED', 'request canceled', {
          reason: 'request_canceled',
          hint: 'The request was canceled intentionally',
          executed: 2,
          partialResults: [{ command: 'press' }, { command: 'fill' }],
          dispatched: 'unknown',
          source: { path: '/tmp/workflow.ad', line: 4 },
          diagnosticId: 'diag-4',
          logPath: '/tmp/request.log',
        });
      }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.message, 'Daemon request deadline exceeded');
        assert.doesNotMatch(String(error.details?.hint), /canceled intentionally/);
        assert.equal(error.details?.reason, 'daemon_request_timeout');
        assert.equal(error.details?.causeReason, 'request_canceled');
        assert.equal(error.details?.timeoutMs, 100);
        assert.equal(error.details?.executed, 2);
        assert.deepEqual(error.details?.partialResults, [
          { command: 'press' },
          { command: 'fill' },
        ]);
        assert.equal(error.details?.dispatched, 'unknown');
        assert.deepEqual(error.details?.source, { path: '/tmp/workflow.ad', line: 4 });
        assert.equal(error.details?.diagnosticId, 'diag-4');
        assert.equal(error.details?.logPath, '/tmp/request.log');
        return true;
      },
    );
  } finally {
    vi.useRealTimers();
  }
});

test('a timer firing after explicit cancellation does not relabel it as a deadline', async () => {
  vi.useFakeTimers();
  try {
    await assert.rejects(
      withRequestDeadline('explicit-first', 100, async () => {
        markRequestCanceled('explicit-first');
        await vi.advanceTimersByTimeAsync(100);
        throw getRequestSignal('explicit-first')?.reason;
      }),
      (error: unknown) =>
        isRequestCanceledError(error) && (error as AppError).details?.reason === 'request_canceled',
    );
  } finally {
    vi.useRealTimers();
  }
});

test.each([false, true])(
  'a throw at the wall-clock cutoff observes the deadline and preserves prior cancellation=%s',
  async (canceled) => {
    vi.useFakeTimers();
    const requestId = `wall-clock-throw-${canceled}`;
    const registration = registerRequestAbort(requestId);
    try {
      const signal = getRequestSignal(requestId)!;
      await assert.rejects(
        withRequestDeadline(requestId, 100, async () => {
          if (canceled) markRequestCanceled(requestId);
          vi.setSystemTime(Date.now() + 100);
          assert.equal(signal.aborted, canceled);
          throw new Error('synchronous operation failed after blocking the event loop');
        }),
        (error: unknown) => {
          if (canceled) return error === signal.reason && isRequestCanceledError(error);
          return (
            error instanceof AppError &&
            error.details?.reason === 'daemon_request_timeout' &&
            error.details.timeoutMs === 100 &&
            isRequestCanceledError(signal.reason)
          );
        },
      );
      assert.equal(signal.aborted, true);
      assert.equal(getRequestSignal(requestId), signal);
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      clearRequestAbortRegistration(registration);
      vi.useRealTimers();
    }
  },
);

test('explicit cancellation still rejects a settled response without deadline metadata', async () => {
  await assert.rejects(
    withRequestDeadline('canceled-response', 100, async () => {
      markRequestCanceled('canceled-response');
      return { ok: true };
    }),
    isRequestCanceledError,
  );
});

test('createRequestCanceledError includes stable cancellation reason marker', () => {
  const err = createRequestCanceledError();
  assert.equal(err.code, 'COMMAND_FAILED');
  assert.equal(err.message, 'request canceled');
  assert.equal(err.details?.reason, 'request_canceled');
  assert.match(String(err.details?.hint), /canceled intentionally/);
});

// The factory is the ONE way to build a canceled error (#1774 consolidated the
// hand-rolled copies): callers may add evidence or a sharper hint, but cannot
// build one the predicate misses, and the cause survives for diagnostics.
test('createRequestCanceledError carries caller evidence but never loses its reason', () => {
  const cause = new Error('socket closed');
  const err = createRequestCanceledError(
    { releasedSessionId: 'wd-1', hint: 'released it', reason: 'something_else' },
    cause,
  );
  assert.equal(err.details?.reason, 'request_canceled');
  assert.equal(err.details?.releasedSessionId, 'wd-1');
  assert.equal(err.details?.hint, 'released it');
  assert.equal(err.cause, cause);
  assert.equal(isRequestCanceledError(err), true);
  assert.equal(isRequestCanceledError(new AppError('UNKNOWN', 'request canceled')), false);
});

test('isRequestCanceledError accepts structured and legacy cancellation errors', () => {
  assert.equal(isRequestCanceledError(createRequestCanceledError()), true);
  assert.equal(isRequestCanceledError(new AppError('COMMAND_FAILED', 'request canceled')), true);
  assert.equal(isRequestCanceledError(new AppError('COMMAND_FAILED', 'different message')), false);
});

// A canceled request's signal carries the typed error as its reason, so every
// `signal.throwIfAborted()`, aborted fetch, and `throw signal.reason` downstream
// reports a canceled request rather than a bare DOMException that normalizes to
// UNKNOWN — without each site having to know the factory exists.
test('a canceled request aborts its signal with the typed canceled error', () => {
  const registration = registerRequestAbort('req-typed-abort');
  try {
    markRequestCanceled('req-typed-abort');
    const signal = registration!.controller.signal;
    assert.equal(signal.aborted, true);
    assert.equal(isRequestCanceledError(signal.reason), true);
    assert.throws(
      () => signal.throwIfAborted(),
      (error: unknown) => isRequestCanceledError(error),
    );
  } finally {
    clearRequestAbortRegistration(registration);
  }
});
