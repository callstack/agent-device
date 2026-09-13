import { expect, test } from 'vitest';
import { createLimrunRequestOperationDrain } from './request-cancellation.ts';

test('releases a settled operation from the drain', async () => {
  const drain = createLimrunRequestOperationDrain();
  await expect(drain.wait(Promise.resolve('provider line'))).resolves.toBe('provider line');
  await expect(drain[Symbol.asyncDispose]()).resolves.toBeUndefined();
});

test('propagates a provider rejection and still releases the drain', async () => {
  const drain = createLimrunRequestOperationDrain();
  await expect(drain.wait(Promise.reject(new Error('socket closed')))).rejects.toThrow(
    'socket closed',
  );
  await expect(drain[Symbol.asyncDispose]()).resolves.toBeUndefined();
});

test('keeps an aborted operation owned until its provider source settles', async () => {
  const drain = createLimrunRequestOperationDrain();
  let settleSource!: (value: string) => void;
  const source = new Promise<string>((resolve) => {
    settleSource = resolve;
  });
  const controller = new AbortController();
  const waiting = drain.wait(source, controller.signal, 'limrun operation aborted');
  const reason = new Error('release the instance');

  controller.abort(reason);
  await expect(waiting).rejects.toBe(reason);

  let released = false;
  const disposing = drain[Symbol.asyncDispose]().then(() => {
    released = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(released).toBe(false);

  settleSource('late provider line');
  await expect(disposing).resolves.toBeUndefined();
  expect(released).toBe(true);
});
