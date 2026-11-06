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
  const provider = lease ? await leaseLifecycleProvider?.release?.(lease, context) : undefined;
  const providerSessionId = providerSessionIdFromData(provider);
  if (lease && providerSessionId) leaseRegistry.recordProviderSession(lease, providerSessionId);
  return { registryReleased: leaseRegistry.releaseLease(request).released, provider };
}
