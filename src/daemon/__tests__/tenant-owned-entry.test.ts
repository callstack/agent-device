import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '../../kernel/errors.ts';
import {
  expiredTenantOwnedEntryError,
  requireTenantOwnedEntry,
  type TenantOwnedResourceKind,
} from '../tenant-owned-entry.ts';

const RESOURCE: TenantOwnedResourceKind = {
  label: 'Artifact',
  expiredHint: 'Re-run the command that produced the artifact.',
};

function captureAppError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    assert.equal(error instanceof AppError, true);
    return error as AppError;
  }
  throw new Error('expected an AppError to be thrown');
}

test('requireTenantOwnedEntry returns entries readable by the tenant', () => {
  const map = new Map([
    ['shared', {}],
    ['owned', { tenantId: 'tenant-a' }],
  ]);
  assert.equal(requireTenantOwnedEntry(map, 'shared', undefined, RESOURCE), map.get('shared'));
  assert.equal(requireTenantOwnedEntry(map, 'shared', 'tenant-b', RESOURCE), map.get('shared'));
  assert.equal(requireTenantOwnedEntry(map, 'owned', 'tenant-a', RESOURCE), map.get('owned'));
});

test('missing entries surface as expired resources with a recovery hint', () => {
  const err = captureAppError(() =>
    requireTenantOwnedEntry(new Map(), 'gone', undefined, RESOURCE),
  );
  assert.equal(err.code, 'COMMAND_FAILED');
  assert.equal(err.message, 'Artifact not found or expired: gone');
  assert.equal(err.details?.reason, 'RESOURCE_EXPIRED');
  assert.equal(err.details?.hint, RESOURCE.expiredHint);
});

test('tenant mismatch stays UNAUTHORIZED and honors plural labels', () => {
  const map = new Map([['owned', { tenantId: 'tenant-a' }]]);
  const singular = captureAppError(() =>
    requireTenantOwnedEntry(map, 'owned', 'tenant-b', RESOURCE),
  );
  assert.equal(singular.code, 'UNAUTHORIZED');
  assert.equal(singular.message, 'Artifact belongs to a different tenant');

  const plural = captureAppError(() =>
    requireTenantOwnedEntry(map, 'owned', undefined, {
      ...RESOURCE,
      label: 'Materialized paths',
      plural: true,
    }),
  );
  assert.equal(plural.code, 'UNAUTHORIZED');
  assert.equal(plural.message, 'Materialized paths belong to a different tenant');
});

test('expiredTenantOwnedEntryError builds the same shape as the missing-entry throw', () => {
  const err = expiredTenantOwnedEntryError(RESOURCE, 'abc');
  assert.equal(err.code, 'COMMAND_FAILED');
  assert.equal(err.message, 'Artifact not found or expired: abc');
  assert.equal(err.details?.reason, 'RESOURCE_EXPIRED');
  assert.equal(err.details?.hint, RESOURCE.expiredHint);
});
