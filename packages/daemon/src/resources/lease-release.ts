import { leaseProviderRequiringRuntime } from '@agent-device/contracts/lease-scope';
import type {
  DeviceLease,
  LeaseLifecycleContext,
  LeaseLifecycleProvider,
} from '@agent-device/contracts/device';
import type { LeaseRegistry } from './lease-registry.ts';
import type { ReleaseLeaseRequest } from './lease-registry-scope.ts';
import { providerSessionIdFromData } from './provider-session-ownership.ts';

export type LeaseReleaseOutcome = {
  registryReleased: boolean;
  provider?: Record<string, unknown>;
};

/** Keep the registry record until the provider confirms release, so failed cleanup remains retryable. */
export async function releaseLease(
  leaseRegistry: LeaseRegistry,
  leaseLifecycleProvider: LeaseLifecycleProvider | undefined,
  lease: DeviceLease | undefined,
  request: ReleaseLeaseRequest,
  context?: LeaseLifecycleContext,
): Promise<LeaseReleaseOutcome> {
  if (!lease) return { registryReleased: false };
  const provider = await releaseProviderRental(leaseLifecycleProvider, lease, context);
  recordProviderSession(leaseRegistry, lease, provider);
  if (provider?.releaseStatus === 'unknown') {
    leaseRegistry.beginProviderLeaseEnd(lease.leaseId, true);
    leaseRegistry.markExpiredProviderReleaseUnknown(lease.leaseId, 'provider-release-unconfirmed');
    return { registryReleased: true, provider };
  }
  const registryReleased = leaseRegistry.releaseLease(request).released;
  if (!registryReleased) leaseRegistry.confirmExpiredLeaseEnd(lease.leaseId, 'providerReleased');
  return { registryReleased, provider };
}

export async function releaseProviderRental(
  provider: LeaseLifecycleProvider | undefined,
  lease: DeviceLease,
  context?: LeaseLifecycleContext,
): Promise<Record<string, unknown> | undefined> {
  if (!provider?.release && leaseProviderRequiringRuntime(lease))
    return { releaseStatus: 'unknown' };
  return await provider?.release?.(lease, context);
}

export function recordProviderSession(
  leaseRegistry: LeaseRegistry,
  lease: DeviceLease,
  providerData: Record<string, unknown> | undefined,
): void {
  const providerSessionId = providerSessionIdFromData(providerData);
  if (!providerSessionId) return;
  leaseRegistry.recordProviderSession(lease, providerSessionId);
}
