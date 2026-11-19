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
  clearRequestCanceled,
  markRequestCanceled,
  registerRequestAbort,
  resolveRequestTrackingId,
  getRequestDeadlineMs,
  getRequestExecutionDeadlineMs,
  getRequestReadOnlyDeadlineMs,
  getRequestSignal,
  throwIfRequestCanceled,
  throwIfRequestExecutionDeadlineExceeded,
  withRequestDeadline,
} from './request-cancel.ts';

test('an early live request remains cancelable after more than 50,000 registrations', () => {
  const requestId = 'early-live-request';
  const registration = registerRequestAbort(requestId)!;
  try {
    for (let index = 0; index < 50_001; index++) {
      registerRequestAbort(`later-live-request-${index}`);
    }
    markRequestCanceled(requestId);
    assert.equal(registration.controller.signal.aborted, true);
    assert.equal(isRequestCanceledError(registration.controller.signal.reason), true);
    assert.equal(getRequestSignal(requestId), registration.controller.signal);
  } finally {
    clearRequestCanceled(requestId);
    for (let index = 0; index < 50_001; index++) {
      clearRequestCanceled(`later-live-request-${index}`);
    }
  }
});

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

test('a nested request keeps its own shorter deadline than its parent', async () => {
  vi.useFakeTimers();
  const parent = registerRequestAbort('parent-deadline');
  try {
    await withRequestDeadline('parent-deadline', 1_000, async () => {
      const child = registerRequestAbort('child-deadline', 'parent-deadline');
      try {
        const signal = getRequestSignal('child-deadline')!;
        let finish!: () => void;
        const pending = withRequestDeadline('child-deadline', 100, async () => {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          signal.throwIfAborted();
          return { ok: true };
        });
        const rejected = assert.rejects(
          pending,
          (error: unknown) =>
            error instanceof AppError &&
            error.details?.reason === 'daemon_request_timeout' &&
            error.details.timeoutMs === 100,
        );
        await vi.advanceTimersByTimeAsync(100);
        assert.equal(signal.aborted, true);
        assert.equal(getRequestSignal('parent-deadline')?.aborted, false);
        finish();
        await rejected;
      } finally {
        clearRequestAbortRegistration(child);
      }
      return { ok: true };
    });
  } finally {
    clearRequestAbortRegistration(parent);
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

test('a request runs under the earlier of its execution and result deadlines', async () => {
  for (const [resultInMs, executionInMs] of [
    [60_000, 1_000],
    [1_000, 60_000],
  ] as const) {
    const resultDeadlineMs = Date.now() + resultInMs;
    const registration = registerRequestAbort('earliest-deadline', undefined, { resultDeadlineMs });
    try {
      assert.equal(getRequestDeadlineMs('earliest-deadline'), resultDeadlineMs);
      const before = Date.now();
      await withRequestDeadline('earliest-deadline', executionInMs, async () => {
        const deadlineMs = getRequestDeadlineMs('earliest-deadline')!;
        const after = Date.now();
        if (executionInMs < resultInMs) {
          assert.ok(deadlineMs >= before + executionInMs && deadlineMs <= after + executionInMs);
        } else {
          assert.equal(deadlineMs, resultDeadlineMs);
        }
        return { ok: true };
      });
    } finally {
      clearRequestAbortRegistration(registration);
    }
  }
  assert.equal(getRequestDeadlineMs('unregistered-request'), undefined);
});

test('a resend loop gets the request deadline only for a read-only request, and an attempt inherits it', () => {
  const deadlineMs = Date.now() + 30_000;
  const read = registerRequestAbort('req-read', undefined, {
    resultDeadlineMs: deadlineMs,
    readOnly: true,
  });
  const action = registerRequestAbort('req-action', undefined, {
    resultDeadlineMs: deadlineMs,
    readOnly: false,
  });
  const step = registerRequestAbort('req-read-step', 'req-read');
  try {
    assert.equal(getRequestReadOnlyDeadlineMs('req-read'), deadlineMs);
    assert.equal(getRequestReadOnlyDeadlineMs('req-read-step'), deadlineMs);
    // A read inside an action leaves the action's budget to the dispatch after it.
    assert.equal(getRequestDeadlineMs('req-action'), deadlineMs);
    assert.equal(getRequestReadOnlyDeadlineMs('req-action'), undefined);
  } finally {
    for (const registration of [step, action, read]) clearRequestAbortRegistration(registration);
  }
});

test.each([false, true])(
  'synchronous execution expiry preserves an earlier caller abort=%s without delivering timers',
  async (canceled) => {
    vi.useFakeTimers();
    const requestId = `execution-cutoff-${canceled}`;
    const registration = registerRequestAbort(requestId);
    try {
      const signal = getRequestSignal(requestId)!;
      await assert.rejects(
        withRequestDeadline(requestId, 100, async () => {
          vi.setSystemTime(Date.now() + 99);
          throwIfRequestExecutionDeadlineExceeded(requestId);
          assert.equal(signal.aborted, false);
          if (canceled) markRequestCanceled(requestId);
          const earlierReason: unknown = signal.reason;
          vi.setSystemTime(Date.now() + 1);
          assert.equal(signal.aborted, canceled);
          try {
            throwIfRequestExecutionDeadlineExceeded(requestId);
          } catch (error) {
            if (canceled) assert.equal(error, earlierReason);
            throw error;
          }
          assert.fail('elapsed execution cutoff admitted work');
        }),
        (error: unknown) =>
          error instanceof AppError &&
          error.details?.reason === (canceled ? 'request_canceled' : 'daemon_request_timeout') &&
          (canceled
            ? error === signal.reason && error.details.timeoutMs === undefined
            : error.details.timeoutMs === 100 && error.details.causeReason === 'request_canceled'),
      );
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      clearRequestAbortRegistration(registration);
      vi.useRealTimers();
    }
  },
);

test('an attempt observes a shorter parent execution cutoff installed after registration', async () => {
  vi.useFakeTimers();
  const parent = registerRequestAbort('live-parent-cutoff');
  const child = registerRequestAbort('live-child-cutoff', 'live-parent-cutoff');
  try {
    await assert.rejects(
      withRequestDeadline('live-parent-cutoff', 100, async () => {
        assert.equal(getRequestExecutionDeadlineMs('live-child-cutoff'), Date.now() + 100);
        vi.setSystemTime(Date.now() + 100);
        assert.equal(child!.controller.signal.aborted, false);
        assert.equal(parent!.controller.signal.aborted, false);
        throwIfRequestExecutionDeadlineExceeded('live-child-cutoff');
        assert.fail('attempt lost the parent execution cutoff');
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.details?.reason === 'daemon_request_timeout' &&
        error.details.timeoutMs === 100,
    );
  } finally {
    clearRequestAbortRegistration(child);
    clearRequestAbortRegistration(parent);
    vi.useRealTimers();
  }
});

test('synchronous execution admission does not adopt a transport result deadline', () => {
  vi.useFakeTimers();
  const requestId = 'unarmed-result-cutoff';
  const registration = registerRequestAbort(requestId, undefined, { resultDeadlineMs: Date.now() });
  try {
    throwIfRequestExecutionDeadlineExceeded(requestId);
    assert.equal(getRequestSignal(requestId)?.aborted, false);
    assert.equal(getRequestExecutionDeadlineMs(requestId), undefined);
  } finally {
    clearRequestAbortRegistration(registration);
    vi.useRealTimers();
  }
});

test('an armed request enforces an earlier result cutoff before timer delivery', async () => {
  vi.useFakeTimers();
  const requestId = 'armed-result-cutoff';
  const resultDeadlineMs = Date.now() + 25;
  const registration = registerRequestAbort(requestId, undefined, { resultDeadlineMs });
  try {
    await assert.rejects(
      withRequestDeadline(requestId, 100, async () => {
        assert.equal(getRequestExecutionDeadlineMs(requestId), resultDeadlineMs);
        vi.setSystemTime(resultDeadlineMs);
        assert.equal(getRequestSignal(requestId)?.aborted, false);
        throwIfRequestExecutionDeadlineExceeded(requestId);
        assert.fail('the result cutoff admitted work');
      }),
      (error: unknown) =>
        error instanceof AppError && error.details?.reason === 'daemon_request_timeout',
    );
    assert.equal(getRequestSignal(requestId)?.aborted, true);
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    clearRequestAbortRegistration(registration);
    vi.useRealTimers();
  }
});

test('a longer same-request inner deadline preserves the earlier outer owner without timer delivery', async () => {
  vi.useFakeTimers();
  const requestId = 'outer-before-longer-inner';
  const registration = registerRequestAbort(requestId);
  try {
    await assert.rejects(
      withRequestDeadline(
        requestId,
        100,
        async () =>
          await withRequestDeadline(requestId, 1_000, async () => {
            vi.setSystemTime(Date.now() + 100);
            assert.equal(getRequestSignal(requestId)?.aborted, false);
            throwIfRequestExecutionDeadlineExceeded(requestId);
            assert.fail('the earlier outer cutoff admitted work');
          }),
      ),
      (error: unknown) =>
        error instanceof AppError &&
        error.details?.reason === 'daemon_request_timeout' &&
        error.details.timeoutMs === 100 &&
        error.details.requestId === requestId,
    );
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    clearRequestAbortRegistration(registration);
    vi.useRealTimers();
  }
});

test('a completed shorter inner owner cannot expire its still-live outer request', async () => {
  vi.useFakeTimers();
  const requestId = 'completed-inner-owner';
  const registration = registerRequestAbort(requestId);
  const startedAt = Date.now();
  try {
    const result = await withRequestDeadline(requestId, 1_000, async () => {
      await withRequestDeadline(requestId, 100, async () => {
        vi.setSystemTime(startedAt + 50);
        return { ok: true };
      });
      vi.setSystemTime(startedAt + 101);
      throwIfRequestExecutionDeadlineExceeded(requestId);
      assert.equal(getRequestSignal(requestId)?.aborted, false);
      assert.equal(getRequestExecutionDeadlineMs(requestId), startedAt + 1_000);
      return { ok: true };
    });
    assert.equal(result.ok, true);
    assert.equal(getRequestExecutionDeadlineMs(requestId), undefined);
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    clearRequestAbortRegistration(registration);
    vi.useRealTimers();
  }
});

test.each([
  { childTimeoutMs: 1_000, childStartsAfterMs: 0 },
  { childTimeoutMs: 50, childStartsAfterMs: 50 },
])(
  'an earlier or equal inherited cutoff retains its parent owner (%s)',
  async ({ childTimeoutMs, childStartsAfterMs }) => {
    vi.useFakeTimers();
    const parentId = 'winning-parent-owner';
    const childId = 'longer-child-owner';
    const parent = registerRequestAbort(parentId);
    const child = registerRequestAbort(childId, parentId);
    const startedAt = Date.now();
    try {
      await assert.rejects(
        withRequestDeadline(parentId, 100, async () => {
          vi.setSystemTime(startedAt + childStartsAfterMs);
          return await withRequestDeadline(childId, childTimeoutMs, async () => {
            vi.setSystemTime(startedAt + 100);
            assert.equal(parent!.controller.signal.aborted, false);
            assert.equal(child!.controller.signal.aborted, false);
            throwIfRequestExecutionDeadlineExceeded(childId);
            assert.fail('the child replaced its parent deadline owner');
          });
        }),
        (error: unknown) =>
          error instanceof AppError &&
          error.details?.reason === 'daemon_request_timeout' &&
          error.details.timeoutMs === 100 &&
          error.details.requestId === parentId,
      );
      assert.equal(parent!.controller.signal.aborted, true);
      assert.equal(child!.controller.signal.reason, parent!.controller.signal.reason);
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      clearRequestAbortRegistration(child);
      clearRequestAbortRegistration(parent);
      vi.useRealTimers();
    }
  },
);

test.each([false, true])(
  'earlier overlapping completion preserves the later owner with an external registration=%s',
  async (external) => {
    vi.useFakeTimers();
    const requestId = 'overlapping-deadline-owners';
    const registration = external ? registerRequestAbort(requestId) : undefined;
    const startedAt = Date.now();
    let finishEarlier!: () => void;
    let finishLater!: () => void;
    const earlier = withRequestDeadline(requestId, 100, async () => {
      await new Promise<void>((resolve) => {
        finishEarlier = resolve;
      });
      return { ok: true };
    });
    const later = withRequestDeadline(requestId, 1_000, async () => {
      await new Promise<void>((resolve) => {
        finishLater = resolve;
      });
      getRequestSignal(requestId)!.throwIfAborted();
      return { ok: true };
    });
    const signal = getRequestSignal(requestId)!;
    const laterRejected = assert.rejects(
      later,
      (error: unknown) =>
        error instanceof AppError &&
        error.details?.reason === 'daemon_request_timeout' &&
        error.details.timeoutMs === 1_000,
    );
    try {
      finishEarlier();
      assert.equal((await earlier).ok, true);
      assert.equal(getRequestSignal(requestId), signal);
      await vi.advanceTimersByTimeAsync(100);
      throwIfRequestExecutionDeadlineExceeded(requestId);
      assert.equal(getRequestSignal(requestId)?.aborted, false);
      assert.equal(getRequestExecutionDeadlineMs(requestId), startedAt + 1_000);
      await vi.advanceTimersByTimeAsync(900);
      assert.equal(getRequestSignal(requestId)?.aborted, true);
      finishLater();
      await laterRejected;
      assert.equal(getRequestSignal(requestId), external ? signal : undefined);
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      finishEarlier();
      finishLater();
      await Promise.allSettled([earlier, laterRejected]);
      clearRequestAbortRegistration(registration);
      vi.useRealTimers();
    }
  },
);

test.each([false, true])(
  'an implicit surviving owner retains synchronous expiry and caller cancellation=%s',
  async (canceled) => {
    vi.useFakeTimers();
    const requestId = 'implicit-surviving-deadline';
    const startedAt = Date.now();
    let finishEarlier!: () => void;
    let finishLater!: () => void;
    const earlier = withRequestDeadline(requestId, 100, async () => {
      await new Promise<void>((resolve) => {
        finishEarlier = resolve;
      });
      return { ok: true };
    });
    const later = withRequestDeadline(requestId, 1_000, async () => {
      await new Promise<void>((resolve) => {
        finishLater = resolve;
      });
      getRequestSignal(requestId)!.throwIfAborted();
      return { ok: true };
    });
    const signal = getRequestSignal(requestId)!;
    const rejected = assert.rejects(
      later,
      (error: unknown) =>
        error instanceof AppError &&
        error.details?.reason === (canceled ? 'request_canceled' : 'daemon_request_timeout') &&
        (canceled ? error === signal.reason : error.details.timeoutMs === 1_000),
    );
    try {
      finishEarlier();
      assert.equal((await earlier).ok, true);
      assert.equal(getRequestSignal(requestId), signal);
      if (canceled) markRequestCanceled(requestId);
      vi.setSystemTime(startedAt + 1_000);
      assert.equal(signal.aborted, canceled);
      assert.throws(
        () => throwIfRequestExecutionDeadlineExceeded(requestId),
        isRequestCanceledError,
      );
      assert.equal(signal.aborted, true);
      finishLater();
      await rejected;
      assert.equal(getRequestSignal(requestId), undefined);
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      finishEarlier();
      finishLater();
      await Promise.allSettled([earlier, rejected]);
      clearRequestCanceled(requestId);
      vi.useRealTimers();
    }
  },
);

// #4441 (decision 6856998913): withRequestDeadline honors any earlier registered
// execution/result deadline at admission — a source-install request whose result deadline
// (registered by the admitting transport) already passed is refused before task entry.
test('withRequestDeadline refuses task entry when an earlier registered result deadline already expired', async () => {
  vi.useFakeTimers();
  const requestId = 'expired-result-deadline-at-entry';
  const registration = registerRequestAbort(requestId, undefined, {
    resultDeadlineMs: Date.now() - 1,
  });
  try {
    let entered = false;
    await assert.rejects(
      withRequestDeadline(requestId, 570_000, async () => {
        entered = true;
        return { ok: true };
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.details?.reason === 'daemon_request_timeout' &&
        error.details.timeoutMs === 570_000 &&
        error.details.requestId === requestId,
    );
    assert.equal(entered, false, 'the expired request entered its task');
    assert.equal(getRequestSignal(requestId)?.aborted, true);
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    clearRequestAbortRegistration(registration);
    vi.useRealTimers();
  }
});

test('withRequestDeadline admits task entry while an earlier result deadline is still live', async () => {
  vi.useFakeTimers();
  const requestId = 'live-result-deadline-at-entry';
  const registration = registerRequestAbort(requestId, undefined, {
    resultDeadlineMs: Date.now() + 60_000,
  });
  try {
    let entered = false;
    const result = await withRequestDeadline(requestId, 570_000, async () => {
      entered = true;
      return { ok: true };
    });
    assert.equal(entered, true);
    assert.equal(result.ok, true);
    assert.equal(getRequestSignal(requestId)?.aborted, false);
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    clearRequestAbortRegistration(registration);
    vi.useRealTimers();
  }
});

test('an already-expired result deadline does not relabel an earlier explicit cancellation', async () => {
  vi.useFakeTimers();
  const requestId = 'canceled-before-result-deadline-entry';
  const registration = registerRequestAbort(requestId, undefined, {
    resultDeadlineMs: Date.now() - 1,
  });
  try {
    markRequestCanceled(requestId);
    let entered = false;
    await assert.rejects(
      withRequestDeadline(requestId, 570_000, async () => {
        entered = true;
        return { ok: true };
      }),
      (error: unknown) =>
        isRequestCanceledError(error) &&
        (error as AppError).details?.reason === 'request_canceled' &&
        (error as AppError).details?.timeoutMs === undefined,
    );
    assert.equal(entered, false);
  } finally {
    clearRequestAbortRegistration(registration);
    vi.useRealTimers();
  }
});
