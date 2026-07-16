import fs from 'node:fs';
import path from 'node:path';
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
  stateDir?: string;
  providerRuntimeIds?: readonly string[];
  providerRuntimeRequiredIds?: readonly string[];
  retryDelayMs?: number;
}): ExpiredProviderLeaseReleaser {
  const pendingLeases = loadPendingLeases(options.stateDir);
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let retryTimer: Timer | undefined;
  let retrying = false;

  const persistPendingLeases = (): void => {
    if (!options.stateDir) return;
    const filePath = pendingReleasesPath(options.stateDir);
    try {
      if (pendingLeases.size === 0) {
        fs.rmSync(filePath, { force: true });
        return;
      }
      fs.mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
      const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      const record: PersistedExpiredProviderLeases = {
        version: PENDING_RELEASES_VERSION,
        leases: [...pendingLeases.values()],
      };
      fs.writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
      fs.chmodSync(filePath, 0o600);
    } catch (error) {
      emitDiagnostic({
        level: 'error',
        phase: 'provider_lease_expiry_record_write_failed',
        data: {
          pendingLeaseCount: pendingLeases.size,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  };

  const scheduleRetry = (): void => {
    if (
      retryTimer ||
      ![...pendingLeases.values()].some((lease) =>
        isProviderRuntimeAvailable(lease, options.providerRuntimeIds),
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
        if (!isProviderRuntimeAvailable(lease, options.providerRuntimeIds)) continue;
        if (await releaseExpiredProviderLease(options.leaseLifecycleProvider, lease)) {
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
        !options.leaseLifecycleProvider?.release ||
        !isManagedProviderLease(lease, options.providerRuntimeRequiredIds)
      ) {
        return;
      }
      pendingLeases.set(lease.leaseId, lease);
      persistPendingLeases();
      await retryPending();
    },
    retryPending,
    shutdown: () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
    },
  };
}

function isManagedProviderLease(
  lease: DeviceLease,
  providerRuntimeRequiredIds: readonly string[] | undefined,
): boolean {
  return (
    lease.leaseProvider !== undefined &&
    (providerRuntimeRequiredIds === undefined ||
      providerRuntimeRequiredIds.includes(lease.leaseProvider))
  );
}

function isProviderRuntimeAvailable(
  lease: DeviceLease,
  providerRuntimeIds: readonly string[] | undefined,
): boolean {
  return (
    lease.leaseProvider === undefined ||
    providerRuntimeIds === undefined ||
    providerRuntimeIds.includes(lease.leaseProvider)
  );
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
