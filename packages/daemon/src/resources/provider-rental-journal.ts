import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  DeviceLease,
  LeaseLifecycleContext,
  ProviderRentalIdentity,
} from '@agent-device/contracts/device';
import { normalizeLeaseId } from '@agent-device/contracts/lease-scope';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { publishDurableFileSync } from '@agent-device/host-kit/file';
import { readLeaseBackend } from '@agent-device/kernel/contracts';
import { deviceLeaseBusyError } from './lease-registry-scope.ts';

type Rental = {
  lease: DeviceLease;
  rentalRecoveryPrincipal?: string;
  legacyLeaseId?: string;
  releaseOnRestart: ProviderRentalIdentity;
};

export type ProviderRentalPolicy = (provider: string) => {
  rentalRecoveryPrincipal?: string;
  legacyRecovery: boolean;
};

export type ProviderRentalJournal = ReturnType<typeof createProviderRentalJournal>;

export function createProviderRentalJournal(stateDir: string, policy?: ProviderRentalPolicy) {
  const destination = path.join(stateDir, 'provider-rentals.json');
  let entries = new Map<string, Rental>();
  const unrecordedInstances = new Map<string, string>();
  let closed = false;

  const write = (updated: Map<string, Rental>): void => {
    publishDurableFileSync({
      destination,
      contents: `${JSON.stringify({ version: 1, rentals: [...updated.values()] })}\n`,
      mode: 0o600,
    });
    entries = updated;
  };

  const policyFor = (lease: DeviceLease) =>
    lease.leaseProvider ? policy?.(lease.leaseProvider) : undefined;
  const idFor = (lease: DeviceLease): string =>
    entries.has(lease.leaseId) ? lease.leaseId : rentalId(lease.leaseId);

  const update = (
    lease: DeviceLease,
    change: (entries: Map<string, Rental>, id: string) => void,
  ): void => {
    if (closed) return;
    const updated = new Map(entries);
    change(updated, idFor(lease));
    write(updated);
  };

  const record = (lease: DeviceLease, identity: ProviderRentalIdentity): void => {
    const entry = entries.get(idFor(lease));
    if (closed || !entry) throw new Error('Provider rental reservation is unavailable.');
    update(lease, (updated, id) => {
      updated.set(id, { ...entry, releaseOnRestart: { ...entry.releaseOnRestart, ...identity } });
    });
  };
  const recordInstance = (lease: DeviceLease, instanceId: string): void =>
    record(lease, { instanceId });

  const reportFailure = (lease: DeviceLease, error: unknown): void => {
    emitDiagnostic({
      level: 'error',
      phase: 'provider_rental_journal_write_failed',
      data: { resourcePath: destination, rentalId: idFor(lease), error: String(error) },
    });
  };

  const persistPendingInstance = (lease: DeviceLease): void => {
    const id = idFor(lease);
    const instanceId = unrecordedInstances.get(id);
    if (instanceId === undefined) return;
    recordInstance(lease, instanceId);
    unrecordedInstances.delete(id);
  };
  const retryPendingInstance = (lease: DeviceLease): void => {
    if (closed) return;
    try {
      persistPendingInstance(lease);
    } catch (error) {
      reportFailure(lease, error);
    }
  };

  return {
    restore: () => {
      let contents: string;
      try {
        contents = fs.readFileSync(destination, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      const parsed = JSON.parse(contents) as { version?: unknown; rentals?: unknown };
      if (
        parsed?.version !== 1 ||
        !Array.isArray(parsed.rentals) ||
        !parsed.rentals.every(isRental)
      ) {
        throw new Error(`Invalid provider rental journal: ${destination}`);
      }
      entries = new Map(parsed.rentals.map((entry) => [entry.lease.leaseId, entry]));
    },
    path: destination,
    inheritedLeases: () => [...entries.values()].map(({ lease }) => lease),
    identity: (lease: DeviceLease) => entries.get(idFor(lease))?.releaseOnRestart,
    legacyLeaseId: (lease: DeviceLease) => entries.get(idFor(lease))?.legacyLeaseId,
    hasMatchingRecoveryPrincipal: (lease: DeviceLease) => {
      const recorded = entries.get(idFor(lease))?.rentalRecoveryPrincipal;
      return recorded !== undefined && recorded === policyFor(lease)?.rentalRecoveryPrincipal;
    },
    assertLeaseIdAvailable: (leaseId: string) => {
      if (entries.has(rentalId(leaseId))) {
        throw deviceLeaseBusyError(undefined, 'provider-release-unconfirmed');
      }
    },
    reserve: (lease: DeviceLease) => {
      if (closed) throw new Error('Provider rental journal is closed.');
      const id = rentalId(lease.leaseId);
      const recovery = policyFor(lease);
      const { clientId, retainOnClose, ...scope } = lease;
      update(lease, (updated) =>
        updated.set(id, {
          lease: {
            ...scope,
            leaseId: id,
            ...(recovery?.legacyRecovery ? { clientId, retainOnClose } : {}),
          },
          rentalRecoveryPrincipal: recovery?.rentalRecoveryPrincipal,
          legacyLeaseId: recovery?.legacyRecovery ? lease.leaseId : undefined,
          releaseOnRestart: {},
        }),
      );
    },
    recordInstance,
    persistPendingInstance,
    retryPendingInstance,
    context: (lease: DeviceLease): LeaseLifecycleContext['rental'] => {
      if (!entries.has(idFor(lease))) return undefined;
      return {
        beforeCreate: (reconciliationKey) => record(lease, { reconciliationKey }),
        rented: (instanceId) => {
          const id = idFor(lease);
          if (closed || !entries.has(id)) return;
          unrecordedInstances.set(id, instanceId);
          retryPendingInstance(lease);
        },
      };
    },
    confirmReleased: (lease: DeviceLease): boolean => {
      if (!entries.has(idFor(lease))) return true;
      if (closed) return false;
      const id = idFor(lease);
      try {
        update(lease, (updated, id) => updated.delete(id));
        unrecordedInstances.delete(id);
        return true;
      } catch (error) {
        reportFailure(lease, error);
        return false;
      }
    },
    close: () => {
      closed = true;
    },
  };
}

function rentalId(leaseId: string): string {
  return `rental-${createHash('sha256').update(leaseId).digest('hex')}`;
}

function isRental(value: unknown): value is Rental {
  const entry = value as Partial<Rental> | null;
  return (
    !!entry &&
    isRentalScope(entry.lease) &&
    (entry.rentalRecoveryPrincipal === undefined ||
      (typeof entry.rentalRecoveryPrincipal === 'string' &&
        entry.rentalRecoveryPrincipal.trim().length > 0)) &&
    (entry.legacyLeaseId === undefined ||
      (typeof entry.legacyLeaseId === 'string' &&
        normalizeLeaseId(entry.legacyLeaseId) === entry.legacyLeaseId &&
        rentalId(entry.legacyLeaseId) === entry.lease?.leaseId)) &&
    isRentalIdentity(entry.releaseOnRestart)
  );
}

function isRentalScope(lease: DeviceLease | undefined): boolean {
  return (
    !!lease &&
    typeof lease.leaseId === 'string' &&
    /^rental-[a-f0-9]{64}$/.test(lease.leaseId) &&
    [lease.tenantId, lease.runId, lease.leaseProvider].every(
      (field) => typeof field === 'string',
    ) &&
    typeof lease.backend === 'string' &&
    readLeaseBackend(lease.backend) === lease.backend &&
    (lease.deviceKey === undefined || typeof lease.deviceKey === 'string') &&
    [lease.createdAt, lease.heartbeatAt, lease.expiresAt].every(Number.isFinite)
  );
}

function isRentalIdentity(identity: ProviderRentalIdentity | undefined): boolean {
  return (
    !!identity &&
    typeof identity === 'object' &&
    [identity.reconciliationKey, identity.instanceId].every(
      (field) => field === undefined || typeof field === 'string',
    )
  );
}
