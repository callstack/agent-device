import type { LeaseRegistry } from '../../resources/lease-registry.ts';

export function finishTestLease(
  registry: LeaseRegistry,
  request: Parameters<LeaseRegistry['getLease']>[0],
) {
  const lease = registry.getLease(request);
  if (!lease) return { released: false };
  registry.beginLeaseEnd(lease, { sessionsSettled: true, providerRelease: 'confirmed' });
  registry.confirmLeaseEnd(lease.leaseId, 'providerReleased');
  return { released: true, lease };
}
