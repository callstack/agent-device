import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AsyncCleanupStack, PendingTransferGuard } from './async-lifecycle.ts';

function disposable(run: () => void | Promise<void>): AsyncDisposable {
  return {
    [Symbol.asyncDispose]: async () => await run(),
  };
}

test('async cleanup stack disposes once in reverse acquisition order', async () => {
  const events: string[] = [];
  const stack = new AsyncCleanupStack();
  stack.use(
    disposable(() => {
      events.push('first');
    }),
  );
  stack.defer(async () => {
    events.push('second');
  });

  await stack[Symbol.asyncDispose]();
  await stack[Symbol.asyncDispose]();

  assert.deepEqual(events, ['second', 'first']);
  assert.equal(stack.disposed, true);
  assert.throws(() => stack.defer(async () => {}), /after disposal/);
});

test('async cleanup stack attempts every cleanup and retains every failure', async () => {
  const events: string[] = [];
  const stack = new AsyncCleanupStack();
  stack.defer(async () => {
    events.push('first');
    throw new Error('first failed');
  });
  stack.defer(async () => {
    events.push('second');
    throw new Error('second failed');
  });

  await assert.rejects(
    async () => await stack[Symbol.asyncDispose](),
    (error) =>
      error instanceof AggregateError &&
      error.errors.map(String).join('\n').includes('first failed') &&
      error.errors.map(String).join('\n').includes('second failed'),
  );
  assert.deepEqual(events, ['second', 'first']);
});

test('pending transfer guard cleans only unadopted handles', async () => {
  let pendingCleanupCount = 0;
  const pending = new PendingTransferGuard(
    disposable(() => {
      pendingCleanupCount += 1;
    }),
  );
  await pending[Symbol.asyncDispose]();
  await pending[Symbol.asyncDispose]();
  assert.equal(pendingCleanupCount, 1);
  assert.equal(pending.pending, false);

  let adoptedCleanupCount = 0;
  const adopted = new PendingTransferGuard(
    disposable(() => {
      adoptedCleanupCount += 1;
    }),
  );
  const handle = adopted.transfer();
  await adopted[Symbol.asyncDispose]();
  assert.equal(adoptedCleanupCount, 0);
  await handle[Symbol.asyncDispose]();
  assert.equal(adoptedCleanupCount, 1);
  assert.throws(() => adopted.transfer(), /transferred state/);
});
