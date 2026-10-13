import { test, expect } from 'vitest';
import {
  clearRequestAbortRegistration,
  markRequestCanceled,
  registerRequestAbort,
} from '@agent-device/host-kit/request';
import type { DaemonRequest } from '../daemon-request.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { runAdmittedLeaseWork } from '../request-lease-work.ts';
import { HUMAN_CONTROL_LEASE_REQUEST } from './human-control-fixtures.ts';

function admittedRequest(
  leaseRegistry: LeaseRegistry,
  overrides: Partial<DaemonRequest> = {},
): DaemonRequest {
  return {
    token: 'test-token',
    session: 'default',
    command: 'snapshot',
    positionals: [],
    internal: { admittedLease: leaseRegistry.allocateLease(HUMAN_CONTROL_LEASE_REQUEST) },
    ...overrides,
  };
}

// A capture that runs past the lease TTL used to expire the lease paying for the
// device, so the session died underneath the client still waiting for it.
test('admitted work that outlives the lease TTL keeps the lease it is working on', async () => {
  let now = 0;
  const leaseRegistry = new LeaseRegistry({ now: () => now, defaultLeaseTtlMs: 5_000 });
  const req = admittedRequest(leaseRegistry);

  const worked = await runAdmittedLeaseWork({
    leaseRegistry,
    req,
    task: async () => {
      now = 9_000;
      expect(leaseRegistry.listActiveLeases()).toHaveLength(1);
      return 'captured';
    },
  });

  expect(worked).toBe('captured');
  expect(leaseRegistry.listActiveLeases()[0]?.expiresAt).toBe(14_000);
});

// The pass protects work somebody is still waiting for, and nothing else. Once the
// client hangs up, work that lands later re-earns no lease: a handler that ignores
// its cancellation cannot pin a rented device open.
test('work nobody waited for renews nothing once its lease fell due', async () => {
  let now = 0;
  const leaseRegistry = new LeaseRegistry({ now: () => now, defaultLeaseTtlMs: 5_000 });
  const requestId = 'request-2509-abandoned';
  const registration = registerRequestAbort(requestId);
  try {
    const req = admittedRequest(leaseRegistry, { meta: { requestId } });
    const worked = await runAdmittedLeaseWork({
      leaseRegistry,
      req,
      task: async () => {
        now = 9_000;
        markRequestCanceled(requestId);
        return 'late';
      },
    });

    expect(worked).toBe('late');
    expect(leaseRegistry.listActiveLeases()).toEqual([]);
  } finally {
    clearRequestAbortRegistration(registration);
  }
});

test('a request admitted without a lease runs its work untouched', async () => {
  const leaseRegistry = new LeaseRegistry();
  const result = await runAdmittedLeaseWork({
    leaseRegistry,
    req: { token: 'test-token', session: 'default', command: 'status', positionals: [] },
    task: async () => 'ran',
  });

  expect(result).toBe('ran');
  expect(leaseRegistry.listActiveLeases()).toEqual([]);
});
