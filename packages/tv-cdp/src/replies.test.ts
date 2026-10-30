import assert from 'node:assert/strict';
import { test } from 'vitest';

import { createReplyWaiters } from './replies.ts';

const timeoutError = () => new Error('timed out');
const accept = (reply: string) => ({ value: reply });

test('a reply settles the waiter registered under its id', async () => {
  const replies = createReplyWaiters<string>();
  const waiting = replies.wait('1', 1000, timeoutError, accept);

  replies.deliver('1', 'pong');

  assert.equal(await waiting, 'pong');
});

test('after the connection fails, new waiters reject at once with that failure', async () => {
  const replies = createReplyWaiters<string>();
  const pending = replies.wait('1', 60_000, timeoutError, accept);

  replies.failAll(new Error('socket closed'));

  await assert.rejects(pending, /socket closed/);
  await assert.rejects(replies.wait('2', 60_000, timeoutError, accept), /socket closed/);
});
