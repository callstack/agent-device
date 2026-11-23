import { AsyncResource } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import type {
  DeviceLease,
  LeaseLifecycleProvider,
  ProviderExpiredLeaseRecovery,
} from '@agent-device/contracts/device';
import { publishFileSync } from '@agent-device/host-kit/file';
import type { ProviderRentalJournal } from '../resources/provider-rental-journal.ts';
import type { ReleaseUnknownReason } from '../resources/lease-registry-scope.ts';
import { releaseExpiredProviderLease } from '../sessions/lease-lifecycle.ts';
import { emitDiagnostic, type ResourceDiagnostic } from '@agent-device/host-kit/diagnostics';
import { leaseProviderRequiringRuntime } from '@agent-device/contracts/lease-scope';
import { settleWithin } from '@agent-device/host-kit/settle-within';

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
 * bounded shutdown window in which the final release attempts run. `closed` prevents new attempts,
 * release callbacks, and journal writes so the next daemon can take ownership of the records.
 */
type ReleaserPhase = 'running' | 'draining' | 'closed';

const PHASE_RANK: Record<ReleaserPhase, number> = { running: 0, draining: 1, closed: 2 };

/** Why a release was refused. `closed` names the shutdown boundary; `provider-runtime-unavailable` names a daemon that never had the runtime to end the lease. */
type ReleaseRefusalReason = 'closed' | 'provider-runtime-unavailable';

/**
 * What one `release` call did with the lease it was given.
 *
 * `released` means this daemon ended the lease with its provider. `retrying` means this daemon still
 * owns the lease and will retry release or journal retirement. `not-required` means no provider ever
 * held it. `refused` gives the reason and whether a durable record preserves the scope for restart.
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
   * providers may already be disposed. The outcome's `durable` reports whether a record already exists.
   */
  release: (
    lease: DeviceLease,
    afterSessionCleanup?: Promise<void>,
  ) => Promise<ProviderLeaseReleaseOutcome>;
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
  providerRentals?: ProviderRentalJournal;
  recoverableProviderIds?: readonly string[];
  retryDelayMs?: number;
  onRecovered?: (lease: DeviceLease) => void;
  needsProviderRelease?: (lease: DeviceLease) => boolean;
  /** Returns false if the confirmed release still needs journal retirement. */
  onReleased?: (lease: DeviceLease) => boolean | void;
  onReleaseUnknown?: (lease: DeviceLease, reason: ReleaseUnknownReason) => void;
  /** Gives a timer-driven retry, which runs outside any request, a diagnostics scope. */
  withinDiagnosticsScope?: (run: () => Promise<void>) => Promise<void>;
}): ExpiredProviderLeaseReleaser {
  const pendingLiveLeases = new Map<string, DeviceLease>();
  const pendingRecoveryLeases = new Map<string, DeviceLease>();
  const inheritedRentalIds = new Set<string>();
  const persistedRecoveryLeaseIds = new Set<string>();
  let persistedLiveLeaseIds = new Set<string>();
  const hasRentalRecord = (lease: DeviceLease) =>
    options.providerRentals?.identity(lease) !== undefined;
  let inherited = false;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let retryTimer: Timer | undefined;
  let nextRetryDelayMs = retryDelayMs;
  const activeReleaseAttempts = new Map<string, Promise<void>>();
  const releaseContext = new AsyncResource('ProviderLeaseExpiry');
  const sessionCleanup = new Map<string, Promise<void>>();
  let phase: ReleaserPhase = 'running';
  const isClosed = () => phase === 'closed';
  /** The releases this drain window observed; replaced at each window so one window's set is never another's. */
  let drainReleasedLeases = new Map<string, DeviceLease>();
  const runScoped = (run: () => Promise<void>): void => {
    const guarded = async (): Promise<void> => {
      try {
        await run();
      } catch (error) {
        emitDiagnostic({
          level: 'error',
          phase: 'provider_lease_expiry_timer_failed',
          data: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    };
    // A timer callback has no caller: a scope that cannot even open must not become an unhandled
    // rejection that ends the daemon.
    void (
      options.withinDiagnosticsScope ? options.withinDiagnosticsScope(guarded) : guarded()
    ).catch(() => undefined);
  };

  /** Moves the lifecycle forward and nothing else: the phase never goes back. */
  const advancePhase = (next: ReleaserPhase): void => {
    if (PHASE_RANK[next] > PHASE_RANK[phase]) phase = next;
  };

  const confirmProviderRelease = (
    lease: DeviceLease,
    status: 'released' | 'not-required' = 'released',
  ): boolean => {
    if (options.onReleased?.(lease) === false) return false;
    if (status === 'not-required') return true;
    // The drain window is the only period that reports releases, so the phase is the tracker and the
    // set cannot grow outside it.
    nextRetryDelayMs = retryDelayMs;
    if (phase === 'draining') drainReleasedLeases.set(lease.leaseId, lease);
    return true;
  };

  const persistPendingLeases = (): boolean => {
    if (isClosed()) return false;
    if (!options.stateDir) {
      emitPersistenceFailure(
        pendingRecoveryLeases.size,
        new Error('daemon state directory is unavailable'),
      );
      return false;
    }
    try {
      writeLeaseRecord(
        options.stateDir,
        PENDING_RELEASES_FILE,
        [...pendingRecoveryLeases.values()].filter((lease) => !hasRentalRecord(lease)),
      );
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
      if (!pendingRecoveryLeases.has(leaseId) && !hasRentalRecord(lease))
        pendingRecoveryLeases.set(leaseId, lease);
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
    if (isClosed() || !options.stateDir) return;
    const unpersisted = [...pendingRecoveryLeases.values()].filter(
      (lease) => !persistedRecoveryLeaseIds.has(lease.leaseId),
    );
    // `release` admits only recoverable leases to `pendingRecoveryLeases`, so both sources are already
    // recoverable. The recovery copy is spread last: for a lease in both, the expired one is current.
    const journal = new Map(
      [
        ...liveLeases.filter((lease) => !persistedRecoveryLeaseIds.has(lease.leaseId)),
        ...unpersisted,
      ].map((lease) => [lease.leaseId, lease] as const),
    );
    try {
      writeLeaseRecord(options.stateDir, LIVE_LEASES_FILE, [...journal.values()]);
      persistedLiveLeaseIds = new Set(journal.keys());
      if (journalRetryTimer) clearTimeout(journalRetryTimer);
      journalRetryTimer = undefined;
    } catch (error) {
      emitJournalFailure('provider_lease_journal_write_failed', journal.size, error);
      journalRetryTimer ??= setTimeout(() => {
        journalRetryTimer = undefined;
        runScoped(async () => writeJournal());
      }, retryDelayMs);
      journalRetryTimer.unref?.();
    }
  };
  const inheritedRental = (lease: DeviceLease) =>
    inheritedRentalIds.has(lease.leaseId) ? options.providerRentals : undefined;

  const canRecover = (lease: DeviceLease): boolean => {
    if (options.needsProviderRelease?.(lease) === false) return true;
    const rental = inheritedRental(lease);
    if (!rental) return isRecoverableProviderAvailable(lease, options.recoverableProviderIds);
    if (
      !rental.canUseCredentials(lease) ||
      !isProviderRuntimeAvailable(lease, options.providerRuntimeIds)
    )
      return false;
    if (rental.legacyLeaseId(lease))
      return (
        !!options.recoverExpiredLease &&
        isRecoverableProviderAvailable(lease, options.recoverableProviderIds)
      );
    const identity = rental.identity(lease);
    return (
      !!(identity?.instanceId || identity?.reconciliationKey) &&
      !!options.leaseLifecycleProvider?.recoverRental
    );
  };

  const reportUnavailableRecovery = (
    lease: DeviceLease,
    onDiagnostic: ((diagnostic: ResourceDiagnostic) => void) | undefined,
  ): void => {
    const rental = inheritedRental(lease);
    const reason =
      rental && isProviderRuntimeAvailable(lease, options.providerRuntimeIds)
        ? 'provider-release-unconfirmed'
        : 'provider-runtime-unavailable';
    options.onReleaseUnknown?.(lease, reason);
    onDiagnostic?.({
      phase: 'provider_lease_release_refused',
      resourcePath:
        rental?.path ??
        (options.stateDir
          ? leaseRecordPath(options.stateDir, PENDING_RELEASES_FILE)
          : PENDING_RELEASES_FILE),
      data: {
        leaseId: lease.leaseId,
        provider: lease.leaseProvider,
        releaseStatus: 'unknown',
        reason,
        ...(rental?.canUseCredentials(lease) === false ? { credentialsChanged: true } : {}),
      },
    });
  };

  const recoverInherited = async (
    onDiagnostic?: (diagnostic: ResourceDiagnostic) => void,
  ): Promise<void> => {
    if (isClosed() || inherited) return;
    inherited = true;
    // Everything in the expired record is durable by definition, which is what the persisted ids track.
    for (const [leaseId, lease] of loadLeaseRecord(
      options.stateDir,
      PENDING_RELEASES_FILE,
      onDiagnostic,
    )) {
      if (!hasRentalRecord(lease)) pendingRecoveryLeases.set(leaseId, lease);
    }
    for (const lease of options.providerRentals?.inheritedLeases() ?? []) {
      pendingRecoveryLeases.set(lease.leaseId, lease);
      inheritedRentalIds.add(lease.leaseId);
    }
    for (const leaseId of pendingRecoveryLeases.keys()) persistedRecoveryLeaseIds.add(leaseId);
    adoptOrphanedLeases(onDiagnostic);
    for (const lease of pendingRecoveryLeases.values()) {
      options.onRecovered?.(lease);
      if (
        !canRecover(lease) ||
        (!inheritedRentalIds.has(lease.leaseId) && !options.recoverExpiredLease)
      ) {
        reportUnavailableRecovery(lease, onDiagnostic);
      }
    }
    await retryPending();
  };
  const recordLiveLeases = (leases: readonly DeviceLease[]): void => {
    liveLeases = leases.filter(
      (lease) => leaseProviderRequiringRuntime(lease) !== undefined && !hasRentalRecord(lease),
    );
    writeJournal();
  };

  const scheduleRetry = (): void => {
    if (
      // A closed releaser retries nothing: its providers may already be disposed, and the next daemon
      // inherits whatever these lease records still hold.
      phase === 'closed' ||
      retryTimer ||
      (![...pendingLiveLeases.values()].some(canAttemptLiveRelease) &&
        ![...pendingRecoveryLeases.values()].some(canRecover))
    ) {
      return;
    }
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      nextRetryDelayMs = Math.min(nextRetryDelayMs * 2, 60_000);
      runScoped(retryPending);
    }, nextRetryDelayMs);
    retryTimer.unref?.();
    emitDiagnostic({
      level: 'warn',
      phase: 'provider_lease_expiry_retry_scheduled',
      data: {
        pendingLiveLeaseCount: pendingLiveLeases.size,
        pendingRecoveryLeaseCount: pendingRecoveryLeases.size,
        retryDelayMs: nextRetryDelayMs,
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

  const startReleaseAttempt = (leaseId: string, key: string, run: () => Promise<void>) => {
    const after = sessionCleanup.get(leaseId);
    const runIfOpen = async () => {
      if (!isClosed()) await run();
    };
    const attempt = after
      ? releaseContext.runInAsyncScope(async () => {
          await after;
          if (!isClosed()) await (options.withinDiagnosticsScope?.(runIfOpen) ?? runIfOpen());
        })
      : runIfOpen();
    return trackReleaseAttempt(key, attempt);
  };

  const canAttemptLiveRelease = (lease: DeviceLease): boolean =>
    options.needsProviderRelease?.(lease) === false ||
    (!!options.leaseLifecycleProvider?.release &&
      isProviderRuntimeAvailable(lease, options.providerRuntimeIds));

  const usesLegacyRelease = (lease: DeviceLease): boolean =>
    isRecoverableProviderAvailable(lease, options.recoverableProviderIds) &&
    (!hasRentalRecord(lease) || options.providerRentals?.legacyLeaseId(lease) !== undefined);

  const ensureLiveReleaseAttempt = (lease: DeviceLease): Promise<void> | undefined => {
    if (isClosed() || !canAttemptLiveRelease(lease)) return undefined;
    const key = `live:${lease.leaseId}`;
    const activeAttempt = activeReleaseAttempts.get(key);
    if (activeAttempt) return activeAttempt;
    return startReleaseAttempt(lease.leaseId, key, async () => {
      let released = options.needsProviderRelease?.(lease) === false;
      if (!released) {
        options.providerRentals?.retryPendingInstance(lease);
        released = await releaseLiveProviderLease(options.leaseLifecycleProvider, lease);
      }
      if (isClosed()) return;
      if (released) {
        if (confirmProviderRelease(lease)) pendingLiveLeases.delete(lease.leaseId);
      } else options.onReleaseUnknown?.(lease, 'provider-release-unconfirmed');
    });
  };

  const ensureRecoveryReleaseAttempt = (lease: DeviceLease): Promise<void> | undefined => {
    if (phase === 'closed') return undefined;
    if (!canRecover(lease)) return undefined;
    if (!persistedRecoveryLeaseIds.has(lease.leaseId) && !persistPendingLeases()) return undefined;
    const key = `recovery:${lease.leaseId}`;
    const activeAttempt = activeReleaseAttempts.get(key);
    if (activeAttempt) return activeAttempt;
    const recoverRental = options.leaseLifecycleProvider?.recoverRental;
    const rental = inheritedRental(lease);
    const identity = rental?.identity(lease);
    const legacyLeaseId = rental?.legacyLeaseId(lease);
    const recoverLegacy = options.recoverExpiredLease;
    const recordInstance = (instanceId: string) => rental?.recordInstance(lease, instanceId);
    const recover =
      rental && !legacyLeaseId
        ? identity && recoverRental && (() => recoverRental(lease, identity, recordInstance))
        : recoverLegacy &&
          (() => recoverLegacy(legacyLeaseId ? { ...lease, leaseId: legacyLeaseId } : lease));
    return startReleaseAttempt(lease.leaseId, key, async () => {
      options.providerRentals?.retryPendingInstance(lease);
      const released =
        options.needsProviderRelease?.(lease) === false ||
        (await releaseExpiredProviderLease(recover, lease));
      if (isClosed()) return;
      if (released) {
        if (!confirmProviderRelease(lease)) return;
        pendingRecoveryLeases.delete(lease.leaseId);
        inheritedRentalIds.delete(lease.leaseId);
        persistPendingLeases();
      } else {
        options.onReleaseUnknown?.(lease, 'provider-release-unconfirmed');
        if (identity)
          emitDiagnostic({
            level: 'warn',
            phase: 'provider_rental_release_unknown',
            data: { rentalId: lease.leaseId, provider: lease.leaseProvider, ...identity },
          });
      }
    });
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

  const refuseClosedRelease = (lease: DeviceLease): ProviderLeaseReleaseOutcome => ({
    status: 'refused',
    reason: 'closed',
    durable:
      hasRentalRecord(lease) ||
      persistedLiveLeaseIds.has(lease.leaseId) ||
      persistedRecoveryLeaseIds.has(lease.leaseId),
  });

  /** A lease stays pending until provider release and rental retirement are complete. */
  const releaseOutcomeFor = (
    lease: DeviceLease,
    pendingLeases: ReadonlyMap<string, DeviceLease>,
  ): ProviderLeaseReleaseOutcome => {
    if (!pendingLeases.has(lease.leaseId)) return { status: 'released' };
    // The releaser closed while the provider call was in flight, so nothing here will attempt it again.
    if (isClosed()) return refuseClosedRelease(lease);
    return { status: 'retrying' };
  };

  return {
    beginShutdown: () => {
      advancePhase('draining');
      drainReleasedLeases = new Map();
    },
    release: async (lease, afterSessionCleanup) => {
      if (!leaseProviderRequiringRuntime(lease)) {
        if (!isClosed()) confirmProviderRelease(lease, 'not-required');
        return { status: 'not-required' };
      }
      if (isClosed()) return refuseClosedRelease(lease);
      if (afterSessionCleanup) {
        sessionCleanup.set(lease.leaseId, afterSessionCleanup);
        const forget = () => {
          sessionCleanup.delete(lease.leaseId);
        };
        void afterSessionCleanup.then(forget, forget);
      }
      if (usesLegacyRelease(lease)) {
        // Set before the first await: the registry journals right after `onLeaseExpired` returns, and the
        // journal keeps this lease only while it is pending here and not yet durable.
        pendingRecoveryLeases.set(lease.leaseId, lease);
        if (hasRentalRecord(lease)) persistedRecoveryLeaseIds.add(lease.leaseId);
        const attempt = ensureRecoveryReleaseAttempt(lease);
        if (attempt) await attempt;
        else scheduleRetry();
        return releaseOutcomeFor(lease, pendingRecoveryLeases);
      }
      if (!canAttemptLiveRelease(lease)) {
        options.onReleaseUnknown?.(lease, 'provider-runtime-unavailable');
        return {
          status: 'refused',
          reason: 'provider-runtime-unavailable',
          durable: hasRentalRecord(lease),
        };
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
      // A release that fails inside the budget is still a pending release: the
      // drain reports it, it never throws past the bounded window.
      await settleWithin(() => retryPending(), Math.max(0, timeoutMs)).catch(() => undefined);
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
      if (isClosed()) return;
      if (journalRetryTimer) writeJournal();
      advancePhase('closed');
      options.providerRentals?.close();
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      if (journalRetryTimer) clearTimeout(journalRetryTimer);
      journalRetryTimer = undefined;
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
          const result = await leaseLifecycleProvider.release?.(expiredLease);
          if (result?.release === 'unknown' && result.error) throw result.error;
          return result?.release === 'confirmed';
        }
      : undefined,
    lease,
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
  const contents = `${JSON.stringify({
    version: LEASE_RECORD_VERSION,
    leases: [...leases],
  } satisfies PersistedProviderLeaseRecord)}\n`;
  // `exactMode` is what makes 0600 exact under a wide umask, so no chmod follows.
  publishFileSync({ destination: filePath, contents, mode: 0o600, exactMode: true });
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
