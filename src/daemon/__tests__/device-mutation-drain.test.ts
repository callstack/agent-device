import { createControlLatch } from './human-control-fixtures.ts';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { DeviceMutationDrain } from '../device-mutation-drain.ts';

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
