import { test } from 'vitest';
import { withIosContractDaemon } from './daemon-harness.ts';

test('independent contract daemons can use their own fake simulator with the same ID', async () => {
  await withIosContractDaemon([], async () => {
    await withIosContractDaemon([], async () => {});
  });
});
