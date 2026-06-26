import type { DaemonRequest, DaemonResponse } from '../types.ts';
import type { LeaseRegistry } from '../lease-registry.ts';
import { resolveLeaseScope } from '../lease-context.ts';

type LeaseHandlerArgs = {
  req: DaemonRequest;
  leaseRegistry: LeaseRegistry;
};

export async function handleLeaseCommands(args: LeaseHandlerArgs): Promise<DaemonResponse | null> {
  const { req, leaseRegistry } = args;
  const leaseScope = resolveLeaseScope(req);
  switch (req.command) {
    case 'lease_allocate': {
      const lease = leaseRegistry.allocateLease({
        tenantId: leaseScope.tenantId ?? '',
        runId: leaseScope.runId ?? '',
        backend: leaseScope.leaseBackend,
        leaseProvider: leaseScope.leaseProvider,
        deviceKey: leaseScope.deviceKey,
        clientId: leaseScope.clientId,
        ttlMs: leaseScope.leaseTtlMs,
      });
      return {
        ok: true,
        data: { lease },
      };
    }
    case 'lease_heartbeat': {
      const lease = leaseRegistry.heartbeatLease({
        leaseId: leaseScope.leaseId ?? '',
        tenantId: leaseScope.tenantId,
        runId: leaseScope.runId,
        backend: leaseScope.leaseBackend,
        leaseProvider: leaseScope.leaseProvider,
        deviceKey: leaseScope.deviceKey,
        clientId: leaseScope.clientId,
        ttlMs: leaseScope.leaseTtlMs,
      });
      return {
        ok: true,
        data: { lease },
      };
    }
    case 'lease_release': {
      const result = leaseRegistry.releaseLease({
        leaseId: leaseScope.leaseId ?? '',
        tenantId: leaseScope.tenantId,
        runId: leaseScope.runId,
        backend: leaseScope.leaseBackend,
        leaseProvider: leaseScope.leaseProvider,
        deviceKey: leaseScope.deviceKey,
        clientId: leaseScope.clientId,
      });
      return {
        ok: true,
        data: result,
      };
    }
    default:
      return null;
  }
}
