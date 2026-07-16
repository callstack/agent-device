import fs from 'node:fs';
import path from 'node:path';
import type { ProviderExpiredLeaseRecovery } from '../provider-device-runtime.ts';
import type { LeaseLifecycleProvider } from './handlers/lease.ts';
import { releaseExpiredProviderLease } from './lease-lifecycle.ts';
import type { DeviceLease } from './lease-registry.ts';
import { emitDiagnostic } from '../utils/diagnostics.ts';

const DEFAULT_RETRY_DELAY_MS = 1_000;
const PENDING_RELEASES_FILE = 'expired-provider-leases.json';
const PENDING_RELEASES_VERSION = 1;
const PERSISTED_LEASE_STRING_FIELDS = [
  'leaseId',
  'tenantId',
  'runId',
  'backend',
  'leaseProvider',
] as const;
const PERSISTED_LEASE_NUMBER_FIELDS = ['createdAt', 'heartbeatAt', 'expiresAt'] as const;

type Timer = ReturnType<typeof setTimeout>;

type PersistedExpiredProviderLeases = {
  version: number;
  leases: DeviceLease[];
};

export type ExpiredProviderLeaseReleaser = {
  release: (lease: DeviceLease) => Promise<void>;
  retryPending: () => Promise<void>;
  shutdown: () => void;
};

export function createExpiredProviderLeaseReleaser(options: {
  leaseLifecycleProvider?: LeaseLifecycleProvider;
  providerRuntimeIds?: readonly string[];
  recoverExpiredLease?: ProviderExpiredLeaseRecovery;
  stateDir?: string;
  recoverableProviderIds?: readonly string[];
  retryDelayMs?: number;
}): ExpiredProviderLeaseReleaser {
  const pendingLiveLeases = new Map<string, DeviceLease>();
  const pendingRecoveryLeases = loadPendingLeases(options.stateDir);
  const persistedRecoveryLeaseIds = new Set(pendingRecoveryLeases.keys());
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let retryTimer: Timer | undefined;
  let retrying = false;

  const persistPendingLeases = (): boolean => {
    if (!options.stateDir) {
      emitPersistenceFailure(
        pendingRecoveryLeases.size,
        new Error('daemon state directory is unavailable'),
      );
      return false;
    }
    const filePath = pendingReleasesPath(options.stateDir);
    try {
      if (pendingRecoveryLeases.size === 0) {
        fs.rmSync(filePath, { force: true });
      } else {
        fs.mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
        const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        const record: PersistedExpiredProviderLeases = {
          version: PENDING_RELEASES_VERSION,
          leases: [...pendingRecoveryLeases.values()],
        };
        fs.writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        fs.renameSync(temporaryPath, filePath);
        fs.chmodSync(filePath, 0o600);
      }
      persistedRecoveryLeaseIds.clear();
      for (const leaseId of pendingRecoveryLeases.keys()) {
        persistedRecoveryLeaseIds.add(leaseId);
      }
      return true;
    } catch (error) {
      emitPersistenceFailure(pendingRecoveryLeases.size, error);
      return false;
    }
  };

  const scheduleRetry = (): void => {
    if (
      retryTimer ||
      (!hasRetryableLiveLease(pendingLiveLeases, options.providerRuntimeIds) &&
        !hasRetryableRecoveryLease(pendingRecoveryLeases, options.recoverableProviderIds))
    ) {
      return;
    }
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void retryPending();
    }, retryDelayMs);
    retryTimer.unref?.();
    emitDiagnostic({
      level: 'warn',
      phase: 'provider_lease_expiry_retry_scheduled',
      data: {
        pendingLiveLeaseCount: pendingLiveLeases.size,
        pendingRecoveryLeaseCount: pendingRecoveryLeases.size,
        retryDelayMs,
      },
    });
  };

  const retryPendingLiveLeases = async (): Promise<void> => {
    for (const lease of pendingLiveLeases.values()) {
      if (!isProviderRuntimeAvailable(lease, options.providerRuntimeIds)) continue;
      if (await releaseLiveProviderLease(options.leaseLifecycleProvider, lease)) {
        pendingLiveLeases.delete(lease.leaseId);
      }
    }
  };

  const retryPendingRecoveryLeases = async (): Promise<void> => {
    for (const lease of pendingRecoveryLeases.values()) {
      if (!isRecoverableProviderAvailable(lease, options.recoverableProviderIds)) continue;
      if (!persistedRecoveryLeaseIds.has(lease.leaseId) && !persistPendingLeases()) continue;
      if (await releaseExpiredProviderLease(options.recoverExpiredLease, lease)) {
        pendingRecoveryLeases.delete(lease.leaseId);
        persistPendingLeases();
      }
    }
  };

  const retryPending = async (): Promise<void> => {
    if (retrying) return;
    retrying = true;
    try {
      await retryPendingLiveLeases();
      await retryPendingRecoveryLeases();
    } finally {
      retrying = false;
      if (pendingLiveLeases.size === 0 && pendingRecoveryLeases.size === 0 && retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      } else {
        scheduleRetry();
      }
    }
  };

  return {
    release: async (lease) => {
      if (!lease.leaseProvider) return;
      if (isRecoverableProviderAvailable(lease, options.recoverableProviderIds)) {
        pendingRecoveryLeases.set(lease.leaseId, lease);
        if (persistPendingLeases()) {
          await retryPending();
        } else {
          scheduleRetry();
        }
        return;
      }
      if (!isProviderRuntimeAvailable(lease, options.providerRuntimeIds)) return;
      if (!options.leaseLifecycleProvider?.release) return;
      pendingLiveLeases.set(lease.leaseId, lease);
      await retryPending();
      if (pendingLiveLeases.has(lease.leaseId)) {
        scheduleRetry();
      }
    },
    retryPending,
    shutdown: () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
    },
  };
}

async function releaseLiveProviderLease(
  leaseLifecycleProvider: LeaseLifecycleProvider | undefined,
  lease: DeviceLease,
): Promise<boolean> {
  return await releaseExpiredProviderLease(
    leaseLifecycleProvider?.release
      ? async (expiredLease) => {
          await leaseLifecycleProvider.release?.(expiredLease);
        }
      : undefined,
    lease,
  );
}

function hasRetryableLiveLease(
  pendingLeases: ReadonlyMap<string, DeviceLease>,
  providerRuntimeIds: readonly string[] | undefined,
): boolean {
  return [...pendingLeases.values()].some((lease) =>
    isProviderRuntimeAvailable(lease, providerRuntimeIds),
  );
}

function hasRetryableRecoveryLease(
  pendingLeases: ReadonlyMap<string, DeviceLease>,
  recoverableProviderIds: readonly string[] | undefined,
): boolean {
  return [...pendingLeases.values()].some((lease) =>
    isRecoverableProviderAvailable(lease, recoverableProviderIds),
  );
}

function isProviderRuntimeAvailable(
  lease: DeviceLease,
  providerRuntimeIds: readonly string[] | undefined,
): boolean {
  return (
    lease.leaseProvider !== undefined && providerRuntimeIds?.includes(lease.leaseProvider) === true
  );
}

function isRecoverableProviderAvailable(
  lease: DeviceLease,
  recoverableProviderIds: readonly string[] | undefined,
): boolean {
  return (
    lease.leaseProvider !== undefined &&
    recoverableProviderIds?.includes(lease.leaseProvider) === true
  );
}

function emitPersistenceFailure(pendingLeaseCount: number, error: unknown): void {
  emitDiagnostic({
    level: 'error',
    phase: 'provider_lease_expiry_record_write_failed',
    data: {
      pendingLeaseCount,
      error: error instanceof Error ? error.message : String(error),
    },
  });
}

function loadPendingLeases(stateDir: string | undefined): Map<string, DeviceLease> {
  if (!stateDir) return new Map();
  const filePath = pendingReleasesPath(stateDir);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as PersistedExpiredProviderLeases;
    if (parsed.version !== PENDING_RELEASES_VERSION || !Array.isArray(parsed.leases)) {
      throw new Error('unsupported expiry release record');
    }
    return new Map(
      parsed.leases.filter(isPersistedDeviceLease).map((lease) => [lease.leaseId, lease]),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    emitDiagnostic({
      level: 'warn',
      phase: 'provider_lease_expiry_record_read_failed',
      data: { error: error instanceof Error ? error.message : String(error) },
    });
    return new Map();
  }
}

function isPersistedDeviceLease(value: unknown): value is DeviceLease {
  if (!value || typeof value !== 'object') return false;
  const lease = value as Partial<DeviceLease>;
  return (
    PERSISTED_LEASE_STRING_FIELDS.every((field) => typeof lease[field] === 'string') &&
    PERSISTED_LEASE_NUMBER_FIELDS.every((field) => typeof lease[field] === 'number')
  );
}

function pendingReleasesPath(stateDir: string): string {
  return path.join(stateDir, PENDING_RELEASES_FILE);
}
