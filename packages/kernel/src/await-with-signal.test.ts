import { getEventListeners } from 'node:events';
import { expect, test } from 'vitest';
import { awaitWithSignal } from './await-with-signal.ts';

test.each(['before', 'during'] as const)(
  'removes the abort listener when canceled %s the wait',
  async (when) => {
    const controller = new AbortController();
    if (when === 'before') controller.abort();
    const pending = awaitWithSignal(new Promise<never>(() => {}), controller.signal);
    const outcome = expect(pending).rejects.toMatchObject({
      details: { reason: 'request_canceled' },
    });
    if (when === 'during') controller.abort();
    await outcome;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  },
);

test('preserves typed deadline failures instead of leaking a DOMException', async () => {
  const signal = AbortSignal.abort(new DOMException('expired', 'TimeoutError'));
  await expect(awaitWithSignal(new Promise<never>(() => {}), signal)).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'operation_deadline_expired' },
  });
});

test.each(['before', 'after'] as const)(
  'a throwing abort callback rejects when cancellation occurs %s listener registration',
  async (timing) => {
    const controller = new AbortController();
    const failure = new Error('operation stop failed');
    if (timing === 'before') controller.abort();
    const pending = awaitWithSignal(new Promise<never>(() => {}), controller.signal, () => {
      throw failure;
    });
    const rejected = expect(pending).rejects.toBe(failure);
    if (timing === 'after') controller.abort();
    await rejected;
  },
);
