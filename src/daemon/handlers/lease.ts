import type {
  DeviceLease,
  LeaseLifecycleContext,
  LeaseLifecycleProvider,
} from '@agent-device/contracts/device';
import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type {
  AgentArtifactsResult,
  CloudArtifactProvider,
} from '@agent-device/contracts/observability';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import type { LeaseRegistry } from '../lease-registry.ts';
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
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { LEASE_ALLOCATION_BUDGET_MS } from '../../core/command-descriptor/timeout-policy.ts';
import { getRequestSignal, isRequestCanceled } from '../../request/cancel.ts';
import { listDownloadableArtifacts } from '../artifact-tracking.ts';

type LeaseHandlerArgs = {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  providerRuntimeIds?: readonly string[];
  providerRuntimeRequiredIds?: readonly string[];
  leaseLifecycleProvider?: LeaseLifecycleProvider;
  cloudArtifactProvider?: CloudArtifactProvider;
};

export async function handleLeaseCommands(args: LeaseHandlerArgs): Promise<DaemonResponse | null> {
  const {
    req,
    sessionName,
    sessionStore,
    leaseRegistry,
    providerRuntimeIds,
    providerRuntimeRequiredIds,
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
      assertProviderRuntimeAvailable(
        leaseScope.leaseProvider,
        providerRuntimeIds,
        providerRuntimeRequiredIds,
      );
      const lease = leaseRegistry.allocateLease(leaseScopeToAllocateRequest(leaseScope));
      let providerData: Record<string, unknown> | undefined;
      try {
        providerData = await leaseLifecycleProvider?.allocate?.(lease, {
          ...leaseLifecycleContext(req),
          signal: getRequestSignal(req.meta?.requestId),
          deadline: Date.now() + LEASE_ALLOCATION_BUDGET_MS,
        });
      } catch (error) {
        releaseRegistryLease(leaseRegistry, lease);
        throw error;
      }
      if (isRequestCanceled(req.meta?.requestId)) {
        // The requester left while the provider was allocating; the lease it
        // produced is real (and billed) and nobody will ever release it.
        throw await releaseAllocationForGoneRequester(lease, leaseLifecycleProvider, leaseRegistry);
      }
      return {
        ok: true,
        data: { lease, ...(providerData ? { provider: providerData } : {}) },
      };
    }
    case 'lease_heartbeat': {
      const lease = leaseRegistry.heartbeatLease(leaseScopeToHeartbeatRequest(leaseScope));
      const providerData = await leaseLifecycleProvider?.heartbeat?.(
        lease,
        leaseLifecycleContext(req),
      );
      return {
        ok: true,
        data: { lease, ...(providerData ? { provider: providerData } : {}) },
      };
    }
    case 'lease_release': {
      const releaseRequest = leaseScopeToReleaseRequest(leaseScope);
      const lease = leaseRegistry.getLease(releaseRequest);
      const providerData = lease
        ? await leaseLifecycleProvider?.release?.(lease, leaseLifecycleContext(req))
        : undefined;
      const result = leaseRegistry.releaseLease(releaseRequest);
      return {
        ok: true,
        data: { released: result.released, ...(providerData ? { provider: providerData } : {}) },
      };
    }
    default:
      return null;
  }
}

function releaseRegistryLease(leaseRegistry: LeaseRegistry, lease: DeviceLease): void {
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
}

/**
 * Releases a lease that finished allocating after its requester was gone, and
 * turns the outcome into the canceled-request error the (absent) requester
 * would have received. Release evidence is only claimed on a clean release: a
 * provider that could not delete its session (`warnings`) is reported as such,
 * with the identifiers an operator needs to stop it by hand.
 */
async function releaseAllocationForGoneRequester(
  lease: DeviceLease,
  leaseLifecycleProvider: LeaseLifecycleProvider | undefined,
  leaseRegistry: LeaseRegistry,
): Promise<AppError> {
  const outcome = await releaseProviderLease(lease, leaseLifecycleProvider);
  releaseRegistryLease(leaseRegistry, lease);
  return canceledAllocationError(lease, outcome);
}

type ProviderReleaseOutcome = {
  providerSessionId?: unknown;
  warnings: unknown[];
  releaseError?: string;
};

async function releaseProviderLease(
  lease: DeviceLease,
  leaseLifecycleProvider: LeaseLifecycleProvider | undefined,
): Promise<ProviderReleaseOutcome> {
  try {
    const released = await leaseLifecycleProvider?.release?.(lease);
    return {
      providerSessionId: released?.providerSessionId,
      warnings: Array.isArray(released?.warnings) ? released.warnings : [],
    };
  } catch (error) {
    return { warnings: [], releaseError: errorMessage(error) };
  }
}

function canceledAllocationError(lease: DeviceLease, outcome: ProviderReleaseOutcome): AppError {
  const { providerSessionId, warnings, releaseError } = outcome;
  const released = releaseError === undefined && warnings.length === 0;
  return createRequestCanceledError({
    leaseId: lease.leaseId,
    leaseProvider: lease.leaseProvider,
    providerSessionId,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(releaseError !== undefined ? { releaseError } : {}),
    released,
    hint: released
      ? 'The lease request was canceled while the provider was still allocating; the session it produced was released.'
      : `The lease request was canceled while the provider was still allocating, and the session it produced could NOT be confirmed released — it may still be running and billing. Stop provider session ${String(providerSessionId ?? '(unknown)')} for lease ${lease.leaseId} by hand.`,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function leaseLifecycleContext(req: DaemonRequest): LeaseLifecycleContext {
  return {
    flags: req.flags,
    cwd: typeof req.meta?.cwd === 'string' ? req.meta.cwd : undefined,
  };
}

function assertProviderRuntimeAvailable(
  provider: string | undefined,
  providerRuntimeIds: readonly string[] | undefined,
  providerRuntimeRequiredIds: readonly string[] | undefined,
): void {
  if (
    !provider ||
    providerRuntimeIds === undefined ||
    providerRuntimeRequiredIds === undefined ||
    !providerRuntimeRequiredIds.includes(provider) ||
    providerRuntimeIds.includes(provider)
  ) {
    return;
  }
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    `Provider "${provider}" is not available in this daemon runtime.`,
    {
      provider,
      hint: `Restart the daemon with ${provider} configured, then retry lease allocation.`,
    },
  );
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
