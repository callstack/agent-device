import type { DaemonRequest, DaemonResponse } from '../types.ts';
import type { LeaseRegistry } from '../lease-registry.ts';
import { resolveLeaseScope } from '../lease-context.ts';
import {
  leaseScopeToAllocateRequest,
  leaseScopeToHeartbeatRequest,
  leaseScopeToReleaseRequest,
} from '../../core/lease-scope.ts';

type LeaseHandlerArgs = {
  req: DaemonRequest;
  leaseRegistry: LeaseRegistry;
};

export async function handleLeaseCommands(args: LeaseHandlerArgs): Promise<DaemonResponse | null> {
  const { req, leaseRegistry } = args;
  const leaseScope = resolveLeaseScope(req);
  switch (req.command) {
    case 'lease_allocate': {
      const lease = leaseRegistry.allocateLease(leaseScopeToAllocateRequest(leaseScope));
      return {
        ok: true,
        data: { lease },
      };
    }
    case 'lease_heartbeat': {
      const lease = leaseRegistry.heartbeatLease(leaseScopeToHeartbeatRequest(leaseScope));
      return {
        ok: true,
        data: { lease },
      };
    }
    case 'lease_release': {
      const result = leaseRegistry.releaseLease(leaseScopeToReleaseRequest(leaseScope));
      return {
        ok: true,
        data: result,
      };
    }
    default:
      return null;
  }
}
