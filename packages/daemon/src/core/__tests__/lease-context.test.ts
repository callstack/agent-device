import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildSessionLeaseFromRequest,
  resolveRunnerLogicalLeaseContext,
} from '../lease-context.ts';
import { buildLeaseDiagnosticsContext } from '@agent-device/contracts/lease-scope';

test('buildSessionLeaseFromRequest captures complete request lease scope', () => {
  const lease = buildSessionLeaseFromRequest({
    meta: {
      tenantId: 'tenant-a',
      runId: 'run-1',
      leaseId: 'lease-1',
      leaseBackend: 'ios-instance',
      leaseProvider: 'proxy',
      deviceKey: 'device-1',
      clientId: 'client-a',
    },
  });

  assert.deepEqual(lease, {
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseId: 'lease-1',
    leaseBackend: 'ios-instance',
    leaseProvider: 'proxy',
    deviceKey: 'device-1',
    clientId: 'client-a',
  });
});

test('buildSessionLeaseFromRequest skips incomplete lease scope', () => {
  assert.equal(
    buildSessionLeaseFromRequest({
      meta: {
        tenantId: 'tenant-a',
        runId: 'run-1',
      },
    }),
    undefined,
  );
});

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
