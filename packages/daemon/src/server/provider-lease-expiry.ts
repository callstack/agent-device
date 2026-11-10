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

/**
 * The lifecycle of one releaser. `running` admits releases and re-arms retries. `draining` is the
 * bounded shutdown window in which the final release attempts run. `closed` starts no provider attempt
 * and arms no timer: its providers may already be disposed, and a timer could fire after this daemon
 * released its registration and rewrite records the next daemon owns. It still writes lease records
 * synchronously, because they are how the next daemon learns what to recover.
 */
type ReleaserPhase = 'running' | 'draining' | 'closed';

const PHASE_RANK: Record<ReleaserPhase, number> = { running: 0, draining: 1, closed: 2 };

/** Why a release was refused. `closed` names the shutdown boundary; `provider-runtime-unavailable` names a daemon that never had the runtime to end the lease. */
type ReleaseRefusalReason = 'closed' | 'provider-runtime-unavailable';

/**
 * What one `release` call did with the lease it was given.
 *
 * `released` means this daemon ended the lease with its provider. `retrying` means this daemon still
 * owns the lease and will attempt it again. `not-required` means no provider ever held it. `refused`
 * means this daemon will not end this lease: `reason` says why, and `durable` says whether a lease
 * record now names it for the next daemon. A refused lease whose `durable` is false is a device no
 * daemon will end, so every caller reports it.
 */
export type ProviderLeaseReleaseOutcome =
  | { status: 'released' }
  | { status: 'retrying' }
  | { status: 'not-required' }
  | { status: 'refused'; reason: ReleaseRefusalReason; durable: boolean };

type PersistedProviderLeaseRecord = {
  version: number;
  leases: DeviceLease[];
};

export type ExpiredProviderLeaseReleaser = {
  /** Opens the bounded shutdown window: the final release attempts, and the accounting that feeds the drain report. */
  beginShutdown: () => void;
  /**
   * Ends one lease. Admits it while this releaser runs or is draining, and answers with what it did.
   * Once closed it refuses: no provider attempt starts and no pending work is admitted, because the
   * providers may already be disposed. A recoverable lease is still made durable for the next daemon,
   * which is what the outcome's `durable` answers.
   */
  release: (lease: DeviceLease) => Promise<ProviderLeaseReleaseOutcome>;
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
  /** Gives a timer-driven retry, which runs outside any request, a diagnostics scope. */
  withinDiagnosticsScope?: (run: () => Promise<void>) => Promise<void>;
}): ExpiredProviderLeaseReleaser {
  const pendingLiveLeases = new Map<string, DeviceLease>();
  const pendingRecoveryLeases = new Map<string, DeviceLease>();
  const persistedRecoveryLeaseIds = new Set<string>();
  let inherited = false;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let retryTimer: Timer | undefined;
  const activeReleaseAttempts = new Map<string, Promise<void>>();
  let phase: ReleaserPhase = 'running';
  /** The releases this drain window observed; replaced at each window so one window's set is never another's. */
  let drainReleasedLeases = new Map<string, DeviceLease>();
  const runScoped = (run: () => Promise<void> | void): void => {
    const scoped = async (): Promise<void> => await run();
    void (options.withinDiagnosticsScope ? options.withinDiagnosticsScope(scoped) : scoped());
  };

  /** Moves the lifecycle forward and nothing else: the phase never goes back. */
  const advancePhase = (next: ReleaserPhase): void => {
    if (PHASE_RANK[next] > PHASE_RANK[phase]) phase = next;
  };

  const recordReleasedLease = (lease: DeviceLease): void => {
    // The drain window is the only period that reports releases, so the phase is the tracker and the
    // set cannot grow outside it.
    if (phase === 'draining') drainReleasedLeases.set(lease.leaseId, lease);
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
    const orphaned = loadLeaseRecord(options.stateDir, LIVE_LEASES_FILE, onDiagnostic);
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
      // The retry timer is not armed once closed: it could fire after this daemon released its
      // registration, and writes made then belong to the daemon that holds it.
      if (phase === 'closed') return;
      journalRetryTimer ??= setTimeout(() => {
        journalRetryTimer = undefined;
        runScoped(writeJournal);
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
    for (const [leaseId, lease] of loadLeaseRecord(
      options.stateDir,
      PENDING_RELEASES_FILE,
      onDiagnostic,
    )) {
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
      // A closed releaser retries nothing: its providers may already be disposed, and the next daemon
      // inherits whatever these lease records still hold.
      phase === 'closed' ||
      retryTimer ||
      (!hasRetryableLiveLease(pendingLiveLeases, options.providerRuntimeIds) &&
        !hasRetryableRecoveryLease(pendingRecoveryLeases, options.recoverableProviderIds))
    ) {
      return;
    }
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      runScoped(retryPending);
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
    if (phase === 'closed') return undefined;
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
    if (phase === 'closed') return undefined;
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

  /**
   * Refuses a lease that arrives once this releaser is closed. Nothing is awaited and no attempt is
   * tracked, because that work belongs to the daemon that now owns the state directory. A recoverable
   * lease is still written out: `pendingRecoveryLeases` is the content of its lease record, so writing
   * through the map is what makes the handoff durable, and the outcome says so.
   */
  const refuseClosedRelease = (lease: DeviceLease): ProviderLeaseReleaseOutcome => {
    if (!isRecoverableProviderAvailable(lease, options.recoverableProviderIds)) {
      return { status: 'refused', reason: 'closed', durable: false };
    }
    pendingRecoveryLeases.set(lease.leaseId, lease);
    return { status: 'refused', reason: 'closed', durable: persistPendingLeases() };
  };

  /** What the attempt this release started came to. The pending entry is the provider's answer: it is removed only when the provider confirmed the end. */
  const releaseOutcomeFor = (
    lease: DeviceLease,
    pendingLeases: ReadonlyMap<string, DeviceLease>,
  ): ProviderLeaseReleaseOutcome => {
    if (!pendingLeases.has(lease.leaseId)) return { status: 'released' };
    // The releaser closed while the provider call was in flight, so nothing here will attempt it again.
    if (phase === 'closed') {
      return {
        status: 'refused',
        reason: 'closed',
        durable: persistedRecoveryLeaseIds.has(lease.leaseId),
      };
    }
    return { status: 'retrying' };
  };

  return {
    beginShutdown: () => {
      advancePhase('draining');
      drainReleasedLeases = new Map();
    },
    release: async (lease) => {
      if (!lease.leaseProvider) return { status: 'not-required' };
      if (phase === 'closed') return refuseClosedRelease(lease);
      if (isRecoverableProviderAvailable(lease, options.recoverableProviderIds)) {
        // Set before the first await: the registry journals right after `onLeaseExpired` returns, and the
        // journal keeps this lease only while it is pending here and not yet durable.
        pendingRecoveryLeases.set(lease.leaseId, lease);
        if (persistPendingLeases()) {
          await ensureRecoveryReleaseAttempt(lease);
        } else {
          scheduleRetry();
        }
        return releaseOutcomeFor(lease, pendingRecoveryLeases);
      }
      if (!isProviderRuntimeAvailable(lease, options.providerRuntimeIds)) {
        return { status: 'refused', reason: 'provider-runtime-unavailable', durable: false };
      }
      if (!options.leaseLifecycleProvider?.release) {
        return { status: 'refused', reason: 'provider-runtime-unavailable', durable: false };
      }
      pendingLiveLeases.set(lease.leaseId, lease);
      await ensureLiveReleaseAttempt(lease);
      const outcome = releaseOutcomeFor(lease, pendingLiveLeases);
      if (outcome.status === 'retrying') scheduleRetry();
      return outcome;
    },
    recordLiveLeases,
    recoverInherited,
    retryPending,
    drain: async (timeoutMs) => {
      // Shutdown gets one final, bounded attempt at every pending release. A
      // provider call that hangs must not keep the daemon alive indefinitely.
      const deadline = new AbortController();
      await Promise.race([
        retryPending().finally(() => deadline.abort()),
        sleep(Math.max(0, timeoutMs), deadline.signal),
      ]);
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
        released: [...drainReleasedLeases.values()],
      };
      drainReleasedLeases = new Map();
      return result;
    },
    shutdown: () => {
      advancePhase('closed');
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      if (journalRetryTimer) {
        // One last attempt, so a journal that a retry was still owed does not outlive this daemon stale.
        // The closed phase keeps this the last lease record write that is owed a retry.
        clearTimeout(journalRetryTimer);
        journalRetryTimer = undefined;
        writeJournal();
      }
    },
  };
}

/** One diagnostic event a caller reports, as `emitDiagnostic` takes it. */
export type LeaseReleaseDiagnosticEvent = {
  level: 'warn' | 'error';
  phase: string;
  data: Record<string, unknown>;
};

/**
 * The diagnostic a refusal needs, or `undefined` for any other outcome. Every caller of `release`
 * reports through this mapping, so a refusal cannot look different depending on which path noticed it.
 * A refusal whose lease is not durable names a device no daemon will end, so it is an error and carries
 * the lease provider: that is where an operator ends the device by hand. A release the releaser still
 * owns is already reported by the retry that owns it, and a completed one by its provider.
 */
export function leaseReleaseDiagnosticEvent(
  lease: DeviceLease,
  outcome: ProviderLeaseReleaseOutcome,
): LeaseReleaseDiagnosticEvent | undefined {
  if (outcome.status !== 'refused') return undefined;
  return {
    level: outcome.durable ? 'warn' : 'error',
    phase: 'provider_lease_release_refused',
    data: {
      leaseId: lease.leaseId,
      reason: outcome.reason,
      durable: outcome.durable,
      ...(lease.leaseProvider ? { leaseProvider: lease.leaseProvider } : {}),
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

/**
 * Reads one lease record. A record that exists but cannot be read is left on disk and reported with its
 * path, so an operator can tell which record it is and end its leases by hand.
 */
function loadLeaseRecord(
  stateDir: string | undefined,
  file: string,
  onDiagnostic?: (diagnostic: ResourceDiagnostic) => void,
): Map<string, DeviceLease> {
  if (!stateDir) return new Map();
  const filePath = leaseRecordPath(stateDir, file);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as PersistedProviderLeaseRecord;
    if (parsed.version !== LEASE_RECORD_VERSION || !Array.isArray(parsed.leases)) {
      throw new Error(`unsupported lease record (version ${String(parsed.version)})`);
    }
    return new Map(
      parsed.leases.filter(isPersistedDeviceLease).map((lease) => [lease.leaseId, lease]),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    onDiagnostic?.({
      phase: 'provider_lease_record_read_failed',
      resourcePath: filePath,
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
