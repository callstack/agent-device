import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { AgentArtifactsResult, CloudArtifactProvider } from '../../cloud-artifacts.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import type { DeviceLease, LeaseRegistry } from '../lease-registry.ts';
import type { SessionStore } from '../session-store.ts';
import {
  isProxyLeaseScope,
  resolveLeaseScope,
  resolveRequestOrSessionLeaseScope,
} from '../lease-context.ts';
import {
  leaseScopeToAllocateRequest,
  leaseScopeToHeartbeatRequest,
  leaseScopeToReleaseRequest,
} from '../../core/lease-scope.ts';
import { AppError } from '../../kernel/errors.ts';
import { listDownloadableArtifacts } from '../artifact-tracking.ts';

export type LeaseLifecycleProvider = {
  allocate?: (
    lease: DeviceLease,
    context?: LeaseLifecycleContext,
  ) => Promise<Record<string, unknown> | undefined>;
  heartbeat?: (
    lease: DeviceLease,
    context?: LeaseLifecycleContext,
  ) => Promise<Record<string, unknown> | undefined>;
  release?: (
    lease: DeviceLease,
    context?: LeaseLifecycleContext,
  ) => Promise<Record<string, unknown> | undefined>;
};

export type LeaseLifecycleContext = {
  req: DaemonRequest;
};

type LeaseHandlerArgs = {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  leaseLifecycleProvider?: LeaseLifecycleProvider;
  cloudArtifactProvider?: CloudArtifactProvider;
};

export async function handleLeaseCommands(args: LeaseHandlerArgs): Promise<DaemonResponse | null> {
  const {
    req,
    sessionName,
    sessionStore,
    leaseRegistry,
    leaseLifecycleProvider,
    cloudArtifactProvider,
  } = args;
  const leaseScope = resolveLeaseScope(req);
  switch (req.command) {
    case PUBLIC_COMMANDS.artifacts: {
      const artifactScope = resolveRequestOrSessionLeaseScope(req, sessionStore.get(sessionName));
      return {
        ok: true,
        data: (await listArtifactsForRequest(req, artifactScope, cloudArtifactProvider)) as Record<
          string,
          unknown
        >,
      };
    }
    case 'lease_allocate': {
      const lease = leaseRegistry.allocateLease(leaseScopeToAllocateRequest(leaseScope));
      let providerData: Record<string, unknown> | undefined;
      try {
        providerData = await leaseLifecycleProvider?.allocate?.(lease, { req });
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
      const providerData = await leaseLifecycleProvider?.heartbeat?.(lease, { req });
      return {
        ok: true,
        data: { lease, ...(providerData ? { provider: providerData } : {}) },
      };
    }
    case 'lease_release': {
      const result = leaseRegistry.releaseLease(leaseScopeToReleaseRequest(leaseScope));
      const providerData = result.lease
        ? await leaseLifecycleProvider?.release?.(result.lease, { req })
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

async function listArtifactsForRequest(
  req: DaemonRequest,
  leaseScope: ReturnType<typeof resolveLeaseScope>,
  cloudArtifactProvider: CloudArtifactProvider | undefined,
): Promise<AgentArtifactsResult> {
  const providerSessionId = readFlagString(req.flags, 'providerSessionId');
  if (shouldListDaemonArtifacts(leaseScope, providerSessionId)) {
    return await listDaemonArtifacts(leaseScope.tenantId);
  }

  return await listCloudArtifactsForRequest(leaseScope, providerSessionId, cloudArtifactProvider);
}

function shouldListDaemonArtifacts(
  leaseScope: ReturnType<typeof resolveLeaseScope>,
  providerSessionId: string | undefined,
): boolean {
  return isProxyLeaseScope(leaseScope) || (!leaseScope.leaseProvider && !providerSessionId);
}

async function listDaemonArtifacts(tenantId: string | undefined): Promise<AgentArtifactsResult> {
  const artifacts = await listDownloadableArtifacts(tenantId);
  return {
    source: 'daemon',
    status: 'ready',
    artifacts,
    ...(artifacts.length === 0 ? { message: 'No daemon artifacts available.' } : {}),
  };
}

async function listCloudArtifactsForRequest(
  leaseScope: ReturnType<typeof resolveLeaseScope>,
  providerSessionId: string | undefined,
  cloudArtifactProvider: CloudArtifactProvider | undefined,
): Promise<AgentArtifactsResult> {
  if (!leaseScope.leaseProvider) {
    throw new AppError(
      'INVALID_ARGS',
      'artifacts requires --provider for provider session lookup or an active cloud connection.',
    );
  }
  if (!leaseScope.leaseId && !providerSessionId) {
    throw new AppError(
      'INVALID_ARGS',
      'artifacts requires an active cloud lease or --provider-session <id>.',
    );
  }
  const result = await cloudArtifactProvider?.listCloudArtifacts?.({
    provider: leaseScope.leaseProvider,
    leaseId: leaseScope.leaseId,
    providerSessionId,
  });
  if (!result) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `Cloud artifacts are not available for provider "${leaseScope.leaseProvider}".`,
    );
  }
  return result;
}

function readFlagString(
  flags: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = flags?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
