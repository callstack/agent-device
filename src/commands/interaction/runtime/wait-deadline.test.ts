import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

import { runWithinWaitDeadline } from './wait-deadline.ts';

test('wait deadline combines runtime and command cancellation authorities', async () => {
  const runtime = new AbortController();
  const command = new AbortController();
  let observedAbort = false;
  const pending = runWithinWaitDeadline(
    { signal: runtime.signal },
    { signal: command.signal },
    1_000,
    async (signal) =>
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            observedAbort = true;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  );
  const rejected = assert.rejects(pending, /runtime canceled/);

  runtime.abort(new DOMException('runtime canceled', 'AbortError'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (!observedAbort) command.abort(new DOMException('test cleanup', 'AbortError'));

  assert.equal(observedAbort, true);
  await rejected;
});

test('a poll deadline aborts the capture with a TimeoutError reason', async () => {
  vi.useFakeTimers();
  try {
    let observedSignal: AbortSignal | undefined;
    const pending = runWithinWaitDeadline({}, {}, 10, async (signal) => {
      observedSignal = signal;
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;

    assert.deepEqual(result, { timedOut: true });
    assert.equal(observedSignal?.aborted, true);
    assert.equal((observedSignal?.reason as DOMException | undefined)?.name, 'TimeoutError');
  } finally {
    vi.useRealTimers();
  }
});

test('the wait deadline awaits the capture after aborting it', async () => {
  vi.useFakeTimers();
  try {
    let observedSignal: AbortSignal | undefined;
    let releaseCapture: (() => void) | undefined;
    let returned = false;
    const pending = runWithinWaitDeadline({}, {}, 10, async (signal) => {
      observedSignal = signal;
      await new Promise<void>((resolve) => {
        releaseCapture = resolve;
      });
      return 'capture finished';
    }).then((result) => {
      returned = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(10);
    assert.equal(observedSignal?.aborted, true);
    assert.equal((observedSignal?.reason as DOMException | undefined)?.name, 'TimeoutError');
    assert.equal(returned, false);

    releaseCapture?.();
    assert.deepEqual(await pending, { timedOut: true });
    assert.equal(returned, true);
  } finally {
    vi.useRealTimers();
  }
});
