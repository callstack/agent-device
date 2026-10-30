import fs from 'node:fs';
import path from 'node:path';
import type {
  DeviceLease,
  LeaseLifecycleProvider,
  ProviderExpiredLeaseRecovery,
} from '@agent-device/contracts/device';
import { publishFileSync } from '@agent-device/host-kit/file';
import { releaseExpiredProviderLease } from '../sessions/lease-lifecycle.ts';
import { emitDiagnostic, type ResourceDiagnostic } from '@agent-device/host-kit/diagnostics';
import { sleep } from '@agent-device/host-kit/retry';

const DEFAULT_RETRY_DELAY_MS = 1_000;
const PENDING_RELEASES_FILE = 'expired-provider-leases.json';
/**
 * The recoverable provider leases this daemon holds right now. A daemon that starts and finds this
 * file inherited it from one that died without releasing them, so every lease in it is recovered.
 */
const LIVE_LEASES_FILE = 'live-provider-leases.json';
/** The format version of both lease records: the expired record and the live journal. */
const LEASE_RECORD_VERSION = 1;
const PERSISTED_LEASE_STRING_FIELDS = [
  'leaseId',
  'tenantId',
  'runId',
  'backend',
  'leaseProvider',
] as const;
const PERSISTED_LEASE_NUMBER_FIELDS = ['createdAt', 'heartbeatAt', 'expiresAt'] as const;

type Timer = ReturnType<typeof setTimeout>;

type PersistedProviderLeaseRecord = {
  version: number;
  leases: DeviceLease[];
};

export type ExpiredProviderLeaseReleaser = {
  beginShutdown: () => void;
  release: (lease: DeviceLease) => Promise<void>;
  /** Journals the registry's live provider leases, so a daemon killed while holding them recovers them. */
  recordLiveLeases: (leases: readonly DeviceLease[]) => void;
  /**
   * Reads the lease records an earlier daemon left in the state directory (the expired record and the
   * live journal), moves the journal's leases into recovery, and starts recovering. Call it only once
   * this process holds the daemon registration: before that, both records may belong to a daemon that is
   * still running, and acting on them would end devices it is using. Until then the releaser touches no
   * file in the state directory.
   */
  recoverInherited: (onDiagnostic?: (diagnostic: ResourceDiagnostic) => void) => Promise<void>;
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
  const pendingRecoveryLeases = new Map<string, DeviceLease>();
  const persistedRecoveryLeaseIds = new Set<string>();
  let inherited = false;
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
      // Leases now durable in the expired record no longer need the journal to hold them.
      writeJournal();
      return true;
    } catch (error) {
      emitPersistenceFailure(pendingRecoveryLeases.size, error);
      return false;
    }
  };

  const adoptOrphanedLeases = (onDiagnostic?: (diagnostic: ResourceDiagnostic) => void): void => {
    if (!options.stateDir) return;
    const orphaned = loadLeaseRecord(options.stateDir, LIVE_LEASES_FILE);
    if (orphaned.size === 0) return;
    for (const [leaseId, lease] of orphaned) {
      if (!pendingRecoveryLeases.has(leaseId)) pendingRecoveryLeases.set(leaseId, lease);
    }
    // The journal is dropped only once its leases are in the pending record, so a crash in between
    // leaves them in one file or the other.
    if (!persistPendingLeases()) return;
    try {
      fs.rmSync(leaseRecordPath(options.stateDir, LIVE_LEASES_FILE), { force: true });
    } catch (error) {
      // The leases are durable in the pending record; a journal left behind is adopted again, and the
      // pending record already holds each of its leases once.
      emitJournalFailure('provider_lease_journal_remove_failed', orphaned.size, error);
    }
    // Startup runs outside any request, so the report goes to the daemon log through the startup
    // diagnostics rather than a request scope that does not exist yet.
    onDiagnostic?.({
      phase: 'provider_lease_orphans_adopted',
      resourcePath: leaseRecordPath(options.stateDir, LIVE_LEASES_FILE),
      data: { leaseIds: [...orphaned.keys()] },
    });
  };
  let liveLeases: readonly DeviceLease[] = [];
  let journalRetryTimer: Timer | undefined;
  /**
   * Writes the journal: the registry's live leases, plus every lease that left the registry for recovery
   * but whose expired record is not durable yet, so a crash never finds a lease in neither file. A write
   * that fails is retried with the latest leases until one lands.
   */
  const writeJournal = (): void => {
    if (!options.stateDir) return;
    const unpersisted = [...pendingRecoveryLeases.values()].filter(
      (lease) => !persistedRecoveryLeaseIds.has(lease.leaseId),
    );
    // `release` admits only recoverable leases to `pendingRecoveryLeases`, so both sources are already
    // recoverable. The recovery copy is spread last: for a lease in both, the expired one is current.
    const journal = new Map(
      [...liveLeases, ...unpersisted].map((lease) => [lease.leaseId, lease] as const),
    );
    try {
      writeLeaseRecord(options.stateDir, LIVE_LEASES_FILE, [...journal.values()]);
      if (journalRetryTimer) clearTimeout(journalRetryTimer);
      journalRetryTimer = undefined;
    } catch (error) {
      emitJournalFailure('provider_lease_journal_write_failed', journal.size, error);
      journalRetryTimer ??= setTimeout(() => {
        journalRetryTimer = undefined;
        writeJournal();
      }, retryDelayMs);
      journalRetryTimer.unref?.();
    }
  };
  const recoverInherited = async (
    onDiagnostic?: (diagnostic: ResourceDiagnostic) => void,
  ): Promise<void> => {
    if (inherited) return;
    inherited = true;
    // Everything in the expired record is durable by definition, which is what the persisted ids track.
    for (const [leaseId, lease] of loadLeaseRecord(options.stateDir, PENDING_RELEASES_FILE)) {
      pendingRecoveryLeases.set(leaseId, lease);
    }
    for (const leaseId of pendingRecoveryLeases.keys()) persistedRecoveryLeaseIds.add(leaseId);
    adoptOrphanedLeases(onDiagnostic);
    await retryPending();
  };
  const recordLiveLeases = (leases: readonly DeviceLease[]): void => {
    liveLeases = leases.filter((lease) =>
      isRecoverableProviderAvailable(lease, options.recoverableProviderIds),
    );
    writeJournal();
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
        // Set before the first await: the registry journals right after `onLeaseExpired` returns, and the
        // journal keeps this lease only while it is pending here and not yet durable.
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
    recoverInherited,
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
      if (journalRetryTimer) {
        // One last attempt, so a journal that a retry was still owed does not outlive this daemon stale.
        clearTimeout(journalRetryTimer);
        journalRetryTimer = undefined;
        writeJournal();
      }
      // A last attempt that failed re-armed the timer; nothing runs it after shutdown.
      if (journalRetryTimer) clearTimeout(journalRetryTimer);
      journalRetryTimer = undefined;
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

function emitJournalFailure(phase: string, leaseCount: number, error: unknown): void {
  emitDiagnostic({
    level: 'error',
    phase,
    data: { leaseCount, error: error instanceof Error ? error.message : String(error) },
  });
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
  const record: PersistedProviderLeaseRecord = {
    version: LEASE_RECORD_VERSION,
    leases: [...leases],
  };
  publishFileSync({ destination: filePath, contents: `${JSON.stringify(record)}\n`, mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function loadLeaseRecord(stateDir: string | undefined, file: string): Map<string, DeviceLease> {
  if (!stateDir) return new Map();
  const filePath = leaseRecordPath(stateDir, file);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as PersistedProviderLeaseRecord;
    if (parsed.version !== LEASE_RECORD_VERSION || !Array.isArray(parsed.leases)) {
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
