import fs from 'node:fs';
import path from 'node:path';
import type {
  DeviceLease,
  LeaseLifecycleProvider,
  ProviderExpiredLeaseRecovery,
} from '@agent-device/contracts/device';
import { publishFileSync } from '@agent-device/host-kit/file';
import { releaseExpiredProviderLease } from '../sessions/lease-lifecycle.ts';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { sleep } from '@agent-device/host-kit/retry';

const DEFAULT_RETRY_DELAY_MS = 1_000;
const PENDING_RELEASES_FILE = 'expired-provider-leases.json';
/**
 * The recoverable provider leases this daemon holds right now. A daemon that starts and finds this
 * file inherited it from one that died without releasing them, so every lease in it is recovered.
 */
const LIVE_LEASES_FILE = 'live-provider-leases.json';
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
  /** Journals the registry's live provider leases, so a daemon killed while holding them recovers them. */
  recordLiveLeases: (leases: readonly DeviceLease[]) => void;
  retryPending: () => Promise<void>;
  /**
   * `pending` holds every lease still unreleased; `unknown` is the part of it whose release was
   * still in flight when the budget ran out, so its outcome is not known.
   */
  drain: (timeoutMs: number) => Promise<{
    pending: DeviceLease[];
    unknown: DeviceLease[];
    released: DeviceLease[];
  }>;
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
  const pendingRecoveryLeases = loadLeaseRecord(options.stateDir, PENDING_RELEASES_FILE);
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
    try {
      writeLeaseRecord(options.stateDir, PENDING_RELEASES_FILE, [
        ...pendingRecoveryLeases.values(),
      ]);
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

  const adoptOrphanedLeases = (): void => {
    const orphaned = loadLeaseRecord(options.stateDir, LIVE_LEASES_FILE);
    if (orphaned.size === 0 || !options.stateDir) return;
    for (const [leaseId, lease] of orphaned) {
      if (!pendingRecoveryLeases.has(leaseId)) pendingRecoveryLeases.set(leaseId, lease);
    }
    // The journal is dropped only once its leases are in the pending record, so a crash in between
    // leaves them in one file or the other.
    if (!persistPendingLeases()) return;
    fs.rmSync(leaseRecordPath(options.stateDir, LIVE_LEASES_FILE), { force: true });
    emitDiagnostic({
      level: 'warn',
      phase: 'provider_lease_orphans_adopted',
      data: { leaseIds: [...orphaned.keys()] },
    });
  };
  adoptOrphanedLeases();

  const recordLiveLeases = (leases: readonly DeviceLease[]): void => {
    if (!options.stateDir) return;
    const recoverable = leases.filter((lease) =>
      isRecoverableProviderAvailable(lease, options.recoverableProviderIds),
    );
    try {
      writeLeaseRecord(options.stateDir, LIVE_LEASES_FILE, recoverable);
    } catch (error) {
      emitDiagnostic({
        level: 'error',
        phase: 'provider_lease_journal_write_failed',
        data: {
          leaseCount: recoverable.length,
          error: error instanceof Error ? error.message : String(error),
        },
      });
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
    recordLiveLeases,
    retryPending,
    drain: async (timeoutMs) => {
      // Shutdown gets one final, bounded attempt at every pending release. A
      // provider call that hangs must not keep the daemon alive indefinitely.
      await Promise.race([retryPending(), sleep(Math.max(0, timeoutMs))]);
      const result = {
        pending: [...pendingLiveLeases.values(), ...pendingRecoveryLeases.values()],
        unknown: [
          ...[...pendingLiveLeases.values()].filter((lease) =>
            activeReleaseAttempts.has(`live:${lease.leaseId}`),
          ),
          ...[...pendingRecoveryLeases.values()].filter((lease) =>
            activeReleaseAttempts.has(`recovery:${lease.leaseId}`),
          ),
        ],
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

function writeLeaseRecord(stateDir: string, file: string, leases: readonly DeviceLease[]): void {
  const filePath = leaseRecordPath(stateDir, file);
  if (leases.length === 0) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const record: PersistedExpiredProviderLeases = {
    version: PENDING_RELEASES_VERSION,
    leases: [...leases],
  };
  publishFileSync({ destination: filePath, contents: `${JSON.stringify(record)}\n`, mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function loadLeaseRecord(stateDir: string | undefined, file: string): Map<string, DeviceLease> {
  if (!stateDir) return new Map();
  const filePath = leaseRecordPath(stateDir, file);
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

function leaseRecordPath(stateDir: string, file: string): string {
  return path.join(stateDir, file);
}
