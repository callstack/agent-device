import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildLeaseDiagnosticsContext,
  buildSessionLeaseFromRequest,
  resolveRequestOrSessionLeaseScope,
  type SessionLease,
} from '../lease-context.ts';
import type { DaemonRequest } from '../types.ts';

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

test('resolveRequestOrSessionLeaseScope lets explicit request fields override session lease', () => {
  const sessionLease: SessionLease = {
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseId: 'lease-session',
    leaseBackend: 'ios-instance',
    leaseProvider: 'proxy',
    deviceKey: 'device-1',
    clientId: 'client-a',
  };

  const scope = resolveRequestOrSessionLeaseScope(
    {
      meta: {
        leaseId: 'lease-request',
        leaseProvider: 'limrun',
      },
    },
    { lease: sessionLease },
  );

  assert.deepEqual(scope, {
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseId: 'lease-request',
    leaseBackend: 'ios-instance',
    leaseProvider: 'limrun',
    deviceKey: 'device-1',
    clientId: 'client-a',
  });
});

test('resolveRequestOrSessionLeaseScope accepts deviceLease as session compatibility input', () => {
  const scope = resolveRequestOrSessionLeaseScope({} satisfies Partial<DaemonRequest>, {
    deviceLease: {
      tenantId: 'tenant-a',
      runId: 'run-1',
      leaseId: 'lease-session',
    },
  });

  assert.deepEqual(scope, {
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseId: 'lease-session',
  });
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
