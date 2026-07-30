import assert from 'node:assert/strict';
import { test } from 'vitest';

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
