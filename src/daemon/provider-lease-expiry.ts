import fs from 'node:fs';
import path from 'node:path';
import type { ProviderExpiredLeaseRecovery } from '../provider-device-runtime.ts';
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
  recoverExpiredLease?: ProviderExpiredLeaseRecovery;
  stateDir?: string;
  recoverableProviderIds?: readonly string[];
  retryDelayMs?: number;
}): ExpiredProviderLeaseReleaser {
  const pendingLeases = loadPendingLeases(options.stateDir);
  const persistedLeaseIds = new Set(pendingLeases.keys());
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let retryTimer: Timer | undefined;
  let retrying = false;

  const persistPendingLeases = (): boolean => {
    if (!options.stateDir) {
      emitPersistenceFailure(
        pendingLeases.size,
        new Error('daemon state directory is unavailable'),
      );
      return false;
    }
    const filePath = pendingReleasesPath(options.stateDir);
    try {
      if (pendingLeases.size === 0) {
        fs.rmSync(filePath, { force: true });
      } else {
        fs.mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
        const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        const record: PersistedExpiredProviderLeases = {
          version: PENDING_RELEASES_VERSION,
          leases: [...pendingLeases.values()],
        };
        fs.writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        fs.renameSync(temporaryPath, filePath);
        fs.chmodSync(filePath, 0o600);
      }
      persistedLeaseIds.clear();
      for (const leaseId of pendingLeases.keys()) persistedLeaseIds.add(leaseId);
      return true;
    } catch (error) {
      emitPersistenceFailure(pendingLeases.size, error);
      return false;
    }
  };

  const scheduleRetry = (): void => {
    if (
      retryTimer ||
      ![...pendingLeases.values()].some((lease) =>
        isRecoverableProviderAvailable(lease, options.recoverableProviderIds),
      )
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
      data: { pendingLeaseCount: pendingLeases.size, retryDelayMs },
    });
  };

  const retryPending = async (): Promise<void> => {
    if (retrying) return;
    retrying = true;
    try {
      for (const lease of pendingLeases.values()) {
        if (!isRecoverableProviderAvailable(lease, options.recoverableProviderIds)) continue;
        if (!persistedLeaseIds.has(lease.leaseId) && !persistPendingLeases()) continue;
        if (await releaseExpiredProviderLease(options.recoverExpiredLease, lease)) {
          pendingLeases.delete(lease.leaseId);
          persistPendingLeases();
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
      if (
        !lease.leaseProvider ||
        !options.recoverExpiredLease ||
        !isRecoverableProviderAvailable(lease, options.recoverableProviderIds)
      ) {
        return;
      }
      pendingLeases.set(lease.leaseId, lease);
      if (!persistPendingLeases()) {
        scheduleRetry();
        return;
      }
      await retryPending();
    },
    retryPending,
    shutdown: () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
    },
  };
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
