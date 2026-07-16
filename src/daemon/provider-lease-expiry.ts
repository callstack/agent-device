import type { LeaseLifecycleProvider } from './handlers/lease.ts';
import { releaseExpiredProviderLease } from './lease-lifecycle.ts';
import type { DeviceLease } from './lease-registry.ts';
import { emitDiagnostic } from '../utils/diagnostics.ts';

const DEFAULT_RETRY_DELAY_MS = 1_000;

type Timer = ReturnType<typeof setTimeout>;

export type ExpiredProviderLeaseReleaser = {
  release: (lease: DeviceLease) => Promise<void>;
  retryPending: () => Promise<void>;
  shutdown: () => void;
};

export function createExpiredProviderLeaseReleaser(options: {
  leaseLifecycleProvider?: LeaseLifecycleProvider;
  retryDelayMs?: number;
}): ExpiredProviderLeaseReleaser {
  const pendingLeases = new Map<string, DeviceLease>();
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let retryTimer: Timer | undefined;
  let retrying = false;

  const scheduleRetry = (): void => {
    if (retryTimer || pendingLeases.size === 0) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void retryPending();
    }, retryDelayMs);
    retryTimer.unref?.();
    emitDiagnostic({
      level: 'warn',
      phase: 'provider_lease_expiry_retry_scheduled',
      data: { pendingLeaseCount: pendingLeases.size, retryDelayMs },
    });
  };

  const retryPending = async (): Promise<void> => {
    if (retrying) return;
    retrying = true;
    try {
      for (const lease of pendingLeases.values()) {
        if (await releaseExpiredProviderLease(options.leaseLifecycleProvider, lease)) {
          pendingLeases.delete(lease.leaseId);
        }
      }
    } finally {
      retrying = false;
      if (pendingLeases.size === 0 && retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      } else {
        scheduleRetry();
      }
    }
  };

  return {
    release: async (lease) => {
      if (!lease.leaseProvider || !options.leaseLifecycleProvider?.release) return;
      pendingLeases.set(lease.leaseId, lease);
      await retryPending();
    },
    retryPending,
    shutdown: () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
    },
  };
}
