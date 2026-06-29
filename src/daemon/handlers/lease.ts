import type { DaemonRequest, DaemonResponse } from '../types.ts';
import type { DeviceLease, LeaseRegistry } from '../lease-registry.ts';
import { resolveLeaseScope } from '../lease-context.ts';
import {
  leaseScopeToAllocateRequest,
  leaseScopeToHeartbeatRequest,
  leaseScopeToReleaseRequest,
} from '../../core/lease-scope.ts';

export type LeaseLifecycleProvider = {
  allocate?: (lease: DeviceLease) => Promise<Record<string, unknown> | undefined>;
  heartbeat?: (lease: DeviceLease) => Promise<Record<string, unknown> | undefined>;
  release?: (lease: DeviceLease) => Promise<Record<string, unknown> | undefined>;
};

type LeaseHandlerArgs = {
  req: DaemonRequest;
  leaseRegistry: LeaseRegistry;
  leaseLifecycleProvider?: LeaseLifecycleProvider;
};

export async function handleLeaseCommands(args: LeaseHandlerArgs): Promise<DaemonResponse | null> {
  const { req, leaseRegistry, leaseLifecycleProvider } = args;
  const leaseScope = resolveLeaseScope(req);
  switch (req.command) {
    case 'lease_allocate': {
      const lease = leaseRegistry.allocateLease(leaseScopeToAllocateRequest(leaseScope));
      let providerData: Record<string, unknown> | undefined;
      try {
        providerData = await leaseLifecycleProvider?.allocate?.(lease);
      } catch (error) {
        leaseRegistry.releaseLease(
          leaseScopeToReleaseRequest({
            leaseId: lease.leaseId,
            tenantId: lease.tenantId,
            runId: lease.runId,
            leaseBackend: lease.backend,
            leaseProvider: lease.leaseProvider,
            deviceKey: lease.deviceKey,
            clientId: lease.clientId,
          }),
        );
        throw error;
      }
      return {
        ok: true,
        data: { lease, ...(providerData ? { provider: providerData } : {}) },
      };
    }
    case 'lease_heartbeat': {
      const lease = leaseRegistry.heartbeatLease(leaseScopeToHeartbeatRequest(leaseScope));
      const providerData = await leaseLifecycleProvider?.heartbeat?.(lease);
      return {
        ok: true,
        data: { lease, ...(providerData ? { provider: providerData } : {}) },
      };
    }
    case 'lease_release': {
      const result = leaseRegistry.releaseLease(leaseScopeToReleaseRequest(leaseScope));
      const providerData = result.lease
        ? await leaseLifecycleProvider?.release?.(result.lease)
        : undefined;
      return {
        ok: true,
        data: { released: result.released, ...(providerData ? { provider: providerData } : {}) },
      };
    }
    default:
      return null;
  }
}
