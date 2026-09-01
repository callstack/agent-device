import { createControlLatch } from './human-control-fixtures.ts';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { DeviceMutationDrain } from '../device-mutation-drain.ts';
import { getEventListeners } from 'node:events';

test('drain counts concurrent operations, releases on failure, and isolates device keys', async () => {
  const drain = new DeviceMutationDrain();
  const first = createControlLatch();
  const second = createControlLatch();
  const one = drain.run('device-a', () => first.promise);
  const two = drain.run('device-a', () => second.promise);
  let idle = false;
  const waited = drain.wait('device-a').then(() => {
    idle = true;
  });
  await drain.wait('device-b');
  first.resolve();
  await one;
  assert.equal(idle, false);
  const rejected = assert.rejects(two, /failure/);
  second.reject(new Error('failure'));
  await rejected;
  await waited;
  assert.equal(idle, true);
  await drain.wait('device-a');
});

test('canceling a drain waiter detaches its signal without canceling mutations or other waiters', async () => {
  const drain = new DeviceMutationDrain();
  const finish = createControlLatch();
  const mutation = drain.run('device-a', () => finish.promise);
  const controller = new AbortController();
  const reason = new Error('canceled waiter');
  const rejected = assert.rejects(
    drain.wait('device-a', controller.signal),
    (error) => error === reason,
  );
  let drained = false;
  const survivor = drain.wait('device-a').then(() => {
    drained = true;
  });
  controller.abort(reason);
  await rejected;
  assert.equal(drained, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const successController = new AbortController();
  const successful = drain.wait('device-a', successController.signal);
  finish.resolve();
  await Promise.all([mutation, survivor, successful]);
  assert.equal(drained, true);
  assert.equal(getEventListeners(successController.signal, 'abort').length, 0);
  await assert.rejects(drain.wait('device-a', controller.signal), (error) => error === reason);
});
