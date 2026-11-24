import { leaseProviderRequiringRuntime } from '@agent-device/contracts/lease-scope';
import type {
  DeviceLease,
  LeaseLifecycleContext,
  LeaseLifecycleProvider,
  ProviderLeaseRelease,
} from '@agent-device/contracts/device';
import type { LeaseRegistry } from './lease-registry.ts';
import { providerSessionIdFromData } from './provider-session-ownership.ts';

export async function releaseLease(
  registry: LeaseRegistry,
  provider: LeaseLifecycleProvider | undefined,
  lease: DeviceLease,
  options: {
    sessionsSettled: boolean;
    requestRelease?: 'release' | 'close';
    context?: LeaseLifecycleContext;
  },
): Promise<ProviderLeaseRelease> {
  registry.beginLeaseEnd(lease, { ...options, providerRelease: 'pending' });
  return await registry.joinProviderRelease(lease.leaseId, async () => {
    const outcome = await Promise.resolve()
      .then(() => provider?.release?.(lease, options.context))
      .catch((error: unknown): ProviderLeaseRelease => ({ release: 'unknown', error }));
    if (outcome?.release === 'confirmed' || (!outcome && !leaseProviderRequiringRuntime(lease))) {
      recordProviderSession(registry, lease, outcome?.provider);
      registry.confirmRequestProviderRelease(lease);
      return outcome ?? { release: 'confirmed' };
    }
    registry.markLeaseReleaseUnknown(lease.leaseId, 'provider-release-unconfirmed');
    return outcome?.release === 'unknown' ? outcome : { release: 'unknown' };
  });
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
