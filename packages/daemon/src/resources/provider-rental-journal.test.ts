import { mkdtempForTestSync } from '@agent-device/test-kit';
import { expect, test } from 'vitest';
import { createProviderRentalJournal } from './provider-rental-journal.ts';

test('an allocation holding an old journal callback cannot submit a create after shutdown', () => {
  const journal = createProviderRentalJournal(mkdtempForTestSync('provider-rental-'), undefined);
  const lease = {
    leaseId: '1234567890abcdef1234567890abcdef',
    tenantId: 'tenant',
    runId: 'run',
    backend: 'ios-simulator' as const,
    leaseProvider: 'limrun',
    createdAt: 0,
    heartbeatAt: 0,
    expiresAt: 60_000,
  };
  journal.reserve(lease);
  const context = journal.context(lease)!;
  journal.close();
  expect(() => context.beforeCreate('late-create')).toThrow(
    'Provider rental reservation is unavailable',
  );
  expect(journal.identity(lease)).toEqual({});
});
