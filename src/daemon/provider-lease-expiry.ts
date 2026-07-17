import fs from 'node:fs';
import path from 'node:path';
import type { ProviderExpiredLeaseRecovery } from '../provider-device-runtime.ts';
import type { LeaseLifecycleProvider } from './handlers/lease.ts';
import { releaseExpiredProviderLease } from './lease-lifecycle.ts';
import type { DeviceLease } from './lease-registry.ts';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import { sleep } from '../utils/timeouts.ts';

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
  beginShutdown: () => void;
  release: (lease: DeviceLease) => Promise<void>;
  retryPending: () => Promise<void>;
  drain: (timeoutMs: number) => Promise<{ pending: DeviceLease[]; released: DeviceLease[] }>;
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
  const activeReleaseAttempts = new Map<string, Promise<void>>();
  let trackingShutdownReleases = false;
  const shutdownReleasedLeases = new Map<string, DeviceLease>();

  const recordReleasedLease = (lease: DeviceLease): void => {
    if (trackingShutdownReleases) shutdownReleasedLeases.set(lease.leaseId, lease);
  };

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

  const trackReleaseAttempt = (key: string, attempt: Promise<void>): Promise<void> => {
    activeReleaseAttempts.set(key, attempt);
    const finish = (): void => {
      if (activeReleaseAttempts.get(key) === attempt) activeReleaseAttempts.delete(key);
      if (pendingLiveLeases.size === 0 && pendingRecoveryLeases.size === 0 && retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      } else {
        scheduleRetry();
      }
    };
    void attempt.then(finish, finish);
    return attempt;
  };

  const ensureLiveReleaseAttempt = (lease: DeviceLease): Promise<void> | undefined => {
    if (!isProviderRuntimeAvailable(lease, options.providerRuntimeIds)) return undefined;
    const key = `live:${lease.leaseId}`;
    const activeAttempt = activeReleaseAttempts.get(key);
    if (activeAttempt) return activeAttempt;
    const attempt = (async (): Promise<void> => {
      if (await releaseLiveProviderLease(options.leaseLifecycleProvider, lease)) {
        pendingLiveLeases.delete(lease.leaseId);
        recordReleasedLease(lease);
      }
    })();
    return trackReleaseAttempt(key, attempt);
  };

  const ensureRecoveryReleaseAttempt = (lease: DeviceLease): Promise<void> | undefined => {
    if (!isRecoverableProviderAvailable(lease, options.recoverableProviderIds)) return undefined;
    if (!persistedRecoveryLeaseIds.has(lease.leaseId) && !persistPendingLeases()) return undefined;
    const key = `recovery:${lease.leaseId}`;
    const activeAttempt = activeReleaseAttempts.get(key);
    if (activeAttempt) return activeAttempt;
    const attempt = (async (): Promise<void> => {
      if (await releaseExpiredProviderLease(options.recoverExpiredLease, lease)) {
        pendingRecoveryLeases.delete(lease.leaseId);
        recordReleasedLease(lease);
        persistPendingLeases();
      }
    })();
    return trackReleaseAttempt(key, attempt);
  };

  const retryPending = async (): Promise<void> => {
    const attempts = [
      ...[...pendingLiveLeases.values()].map(ensureLiveReleaseAttempt),
      ...[...pendingRecoveryLeases.values()].map(ensureRecoveryReleaseAttempt),
    ].filter((attempt): attempt is Promise<void> => attempt !== undefined);
    if (attempts.length === 0) {
      scheduleRetry();
      return;
    }
    await Promise.all(attempts);
  };

  return {
    beginShutdown: () => {
      shutdownReleasedLeases.clear();
      trackingShutdownReleases = true;
    },
    release: async (lease) => {
      if (!lease.leaseProvider) return;
      if (isRecoverableProviderAvailable(lease, options.recoverableProviderIds)) {
        pendingRecoveryLeases.set(lease.leaseId, lease);
        if (persistPendingLeases()) {
          await ensureRecoveryReleaseAttempt(lease);
        } else {
          scheduleRetry();
        }
        return;
      }
      if (!isProviderRuntimeAvailable(lease, options.providerRuntimeIds)) return;
      if (!options.leaseLifecycleProvider?.release) return;
      pendingLiveLeases.set(lease.leaseId, lease);
      await ensureLiveReleaseAttempt(lease);
      if (pendingLiveLeases.has(lease.leaseId)) {
        scheduleRetry();
      }
    },
    retryPending,
    drain: async (timeoutMs) => {
      // Shutdown gets one final, bounded attempt at every pending release. A
      // provider call that hangs must not keep the daemon alive indefinitely.
      await Promise.race([retryPending(), sleep(Math.max(0, timeoutMs))]);
      const result = {
        pending: [...pendingLiveLeases.values(), ...pendingRecoveryLeases.values()],
        released: [...shutdownReleasedLeases.values()],
      };
      trackingShutdownReleases = false;
      shutdownReleasedLeases.clear();
      return result;
    },
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
