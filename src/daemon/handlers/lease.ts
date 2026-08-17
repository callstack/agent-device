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
import type { LeaseRegistry, ReleaseLeaseRequest } from '../lease-registry.ts';
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
import { AppError, createRequestCanceledError, errorMessage } from '@agent-device/kernel/errors';
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
        leaseRegistry.releaseLease(leaseReleaseRequestFor(lease));
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
      const outcome = await releaseLease(
        leaseRegistry,
        leaseLifecycleProvider,
        leaseRegistry.getLease(releaseRequest),
        releaseRequest,
        leaseLifecycleContext(req),
      );
      return {
        ok: true,
        data: {
          // Wire field: the daemon's registry record; provider cleanup rides in `provider`.
          released: outcome.registryReleased,
          ...(outcome.provider ? { provider: outcome.provider } : {}),
        },
      };
    }
    default:
      return null;
  }
}

function leaseReleaseRequestFor(lease: DeviceLease): ReleaseLeaseRequest {
  return leaseScopeToReleaseRequest({
    leaseId: lease.leaseId,
    tenantId: lease.tenantId,
    runId: lease.runId,
    leaseBackend: lease.backend,
    leaseProvider: lease.leaseProvider,
    deviceKey: lease.deviceKey,
    clientId: lease.clientId,
  });
}

type LeaseReleaseOutcome = {
  /** The daemon's own lease record was released (bookkeeping, not the billed resource). */
  registryReleased: boolean;
  /** Provider release data (providerSessionId, warnings, cloudArtifacts…) when a provider held it. */
  provider?: Record<string, unknown>;
};

/** THE release path: provider first (it still needs the lease record), then the registry. */
async function releaseLease(
  leaseRegistry: LeaseRegistry,
  leaseLifecycleProvider: LeaseLifecycleProvider | undefined,
  lease: DeviceLease | undefined,
  request: ReleaseLeaseRequest,
  context?: LeaseLifecycleContext,
): Promise<LeaseReleaseOutcome> {
  const provider = lease ? await leaseLifecycleProvider?.release?.(lease, context) : undefined;
  return { registryReleased: leaseRegistry.releaseLease(request).released, provider };
}

/**
 * Releases a lease that finished allocating after its requester was gone and
 * turns the outcome into the canceled-request error nobody is left to receive:
 * a throwing provider release is folded into `releaseError` rather than raised,
 * and the provider session counts as released only when it reported no
 * warnings — otherwise the error names what an operator must stop by hand.
 */
async function releaseAllocationForGoneRequester(
  lease: DeviceLease,
  leaseLifecycleProvider: LeaseLifecycleProvider | undefined,
  leaseRegistry: LeaseRegistry,
): Promise<AppError> {
  const request = leaseReleaseRequestFor(lease);
  let outcome: LeaseReleaseOutcome;
  let releaseError: string | undefined;
  try {
    outcome = await releaseLease(leaseRegistry, leaseLifecycleProvider, lease, request);
  } catch (error) {
    releaseError = errorMessage(error);
    outcome = { registryReleased: leaseRegistry.releaseLease(request).released };
  }
  return canceledAllocationError(lease, outcome, releaseError);
}

function canceledAllocationError(
  lease: DeviceLease,
  outcome: LeaseReleaseOutcome,
  releaseError: string | undefined,
): AppError {
  const providerSessionId = outcome.provider?.providerSessionId;
  const warnings = Array.isArray(outcome.provider?.warnings) ? outcome.provider.warnings : [];
  // `released` answers the operator's question — is the billed session gone? —
  // and is only true when the provider released without warnings or throwing.
  const released = outcome.registryReleased && releaseError === undefined && warnings.length === 0;
  return createRequestCanceledError({
    leaseId: lease.leaseId,
    leaseProvider: lease.leaseProvider,
    released,
    registryReleased: outcome.registryReleased,
    providerSessionId,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(releaseError !== undefined ? { releaseError } : {}),
    hint: canceledAllocationHint(released, lease.leaseId, providerSessionId),
  });
}

function canceledAllocationHint(
  released: boolean,
  leaseId: string,
  providerSessionId: unknown,
): string {
  if (released) {
    return 'The lease request was canceled while the provider was still allocating; the session it produced was released.';
  }
  return `The lease request was canceled while the provider was still allocating, and the session it produced could NOT be confirmed released — it may still be running and billing. Stop provider session ${String(providerSessionId ?? '(unknown)')} for lease ${leaseId} by hand.`;
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
