import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { createLeaseLedger } from './connection-lease-transaction.ts';

test('rejecting a second tracked allocation preserves the first lease for rollback', async () => {
  const ledger = createLeaseLedger();
  const released: string[] = [];
  ledger.track({
    leaseId: 'first',
    rollbackOnFailure: true,
    release: async () => {
      released.push('first');
      return { released: true };
    },
  });
  assert.throws(
    () =>
      ledger.track({
        leaseId: 'second',
        rollbackOnFailure: true,
        release: async () => {
          released.push('second');
          return { released: true };
        },
      }),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'LEASE_LEDGER_OVERWRITE',
  );
  const primary = new AppError('COMMAND_FAILED', 'materialization failed');
  assert.equal(await ledger.releaseOwnedOnFailure(primary), primary);
  assert.deepEqual(released, ['first']);
});
