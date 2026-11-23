import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  DeviceLease,
  LeaseLifecycleContext,
  ProviderRentalIdentity,
} from '@agent-device/contracts/device';
import type { DaemonProviderCredentials } from '@agent-device/daemon-contracts/provider-credentials';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { publishDurableFileSync } from '@agent-device/host-kit/file';
import { readLeaseBackend } from '@agent-device/kernel/contracts';
import { deviceLeaseBusyError } from './lease-registry-scope.ts';

type Rental = {
  lease: DeviceLease;
  credentialFingerprint?: string;
  releaseOnRestart: ProviderRentalIdentity;
};

export type ProviderRentalJournal = ReturnType<typeof createProviderRentalJournal>;

export function createProviderRentalJournal(
  stateDir: string,
  credentials: DaemonProviderCredentials | undefined,
) {
  const destination = path.join(stateDir, 'provider-rentals.json');
  let entries = new Map<string, Rental>();
  let closed = false;

  const write = (updated: Map<string, Rental>): void => {
    publishDurableFileSync({
      destination,
      contents: `${JSON.stringify({ version: 1, rentals: [...updated.values()] })}\n`,
      mode: 0o600,
    });
    entries = updated;
  };

  const fingerprint = (lease: DeviceLease) =>
    lease.leaseProvider && credentials?.fingerprint(lease.leaseProvider, lease.backend);
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
    canUseCredentials: (lease: DeviceLease) => {
      const recorded = entries.get(idFor(lease))?.credentialFingerprint;
      return recorded === undefined || recorded === fingerprint(lease);
    },
    assertLeaseIdAvailable: (leaseId: string) => {
      if (entries.has(rentalId(leaseId))) {
        throw deviceLeaseBusyError(undefined, 'provider-release-unconfirmed');
      }
    },
    reserve: (lease: DeviceLease) => {
      if (closed) throw new Error('Provider rental journal is closed.');
      const id = rentalId(lease.leaseId);
      const {
        backend,
        deviceKey,
        leaseProvider,
        tenantId,
        runId,
        createdAt,
        heartbeatAt,
        expiresAt,
      } = lease;
      update(lease, (updated) =>
        updated.set(id, {
          lease: {
            leaseId: id,
            backend,
            deviceKey,
            leaseProvider,
            tenantId,
            runId,
            createdAt,
            heartbeatAt,
            expiresAt,
          },
          credentialFingerprint: fingerprint(lease),
          releaseOnRestart: {},
        }),
      );
    },
    recordInstance,
    context: (lease: DeviceLease): LeaseLifecycleContext['rental'] => {
      if (!entries.has(idFor(lease))) return undefined;
      return {
        beforeCreate: (reconciliationKey) => record(lease, { reconciliationKey }),
        rented: (instanceId) => {
          if (closed) return;
          try {
            recordInstance(lease, instanceId);
          } catch (error) {
            reportFailure(lease, error);
          }
        },
      };
    },
    confirmReleased: (lease: DeviceLease) => {
      if (!entries.has(idFor(lease))) return;
      try {
        update(lease, (updated, id) => updated.delete(id));
      } catch (error) {
        reportFailure(lease, error);
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
    (entry.credentialFingerprint === undefined ||
      typeof entry.credentialFingerprint === 'string') &&
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
