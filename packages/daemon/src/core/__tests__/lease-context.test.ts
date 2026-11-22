import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  LEASE_FIELD_NORMALIZERS,
  assertRequestPresentsLease,
  handDownRequestLeaseScope,
  resolveRunnerLogicalLeaseContext,
  type SessionLease,
} from '../lease-context.ts';
import type { DaemonRequest } from '../daemon-request.ts';
import { buildLeaseDiagnosticsContext } from '@agent-device/contracts/lease-scope';

test('buildLeaseDiagnosticsContext strips ttl and empty fields', () => {
  const context = buildLeaseDiagnosticsContext({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseId: 'lease-1',
    leaseTtlMs: 60_000,
    leaseProvider: 'proxy',
    deviceKey: 'device-1',
  });

  assert.deepEqual(context, {
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseId: 'lease-1',
    leaseProvider: 'proxy',
    deviceKey: 'device-1',
  });
  assert.equal(buildLeaseDiagnosticsContext({}), undefined);
});

test('resolveRunnerLogicalLeaseContext keeps lease backend separate from provider', () => {
  const context = resolveRunnerLogicalLeaseContext({
    meta: {
      leaseId: 'lease-1',
      leaseBackend: 'ios-instance',
      tenantId: 'tenant-a',
      runId: 'run-1',
    },
  });

  assert.deepEqual(context, {
    leaseId: 'lease-1',
    tenantId: 'tenant-a',
    runId: 'run-1',
  });
});

test.each([
  [
    'a displaced claim',
    {
      meta: { tenantId: 'tenant-a' },
      internal: { displacedLeaseClaims: { tenantId: ['tenant-other'] } },
    },
  ],
  [
    'a flag that its meta hides',
    { meta: { tenantId: 'tenant-a' }, flags: { tenant: 'tenant-other' } },
  ],
  ['its scope value', { meta: { tenantId: 'tenant-other' } }],
  ['a null claim', { meta: { tenantId: null as never } }],
])('a nested request carries %s of its parent whatever the step names', async (_label, parent) => {
  const lease: SessionLease = {
    leaseId: 'a'.repeat(32),
    tenantId: 'tenant-a',
    runId: 'run-1',
    backend: 'ios-simulator',
  };
  const nested: DaemonRequest[] = [];
  const invoke = handDownRequestLeaseScope(async (req) => {
    nested.push(req);
    return { ok: true };
  }, parent);
  const step = {
    token: 't',
    session: 's',
    command: 'snapshot',
    positionals: [],
    meta: { leaseId: lease.leaseId },
  };

  await invoke(step);
  await invoke({ ...step, meta: { ...step.meta, tenantId: 'tenant-a' } });

  for (const req of nested) {
    assert.throws(
      () => assertRequestPresentsLease(req, lease),
      (error: unknown) =>
        (error as { details?: { reason?: string; field?: string } }).details?.reason ===
          'LEASE_SESSION_MISMATCH' &&
        (error as { details?: { field?: string } }).details?.field === 'tenantId',
    );
  }
});

test('a lease field value that is not a string names nothing and does not throw', () => {
  for (const normalize of Object.values(LEASE_FIELD_NORMALIZERS)) {
    for (const value of [false, 0, 5, {}, [], null, undefined]) {
      assert.equal(normalize(value), undefined);
    }
  }
});
