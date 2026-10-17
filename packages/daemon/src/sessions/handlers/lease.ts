import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type {
  DeviceLease,
  LeaseLifecycleContext,
  LeaseLifecycleProvider,
} from '@agent-device/contracts/device';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type {
  AgentArtifactsResult,
  CloudArtifactProvider,
} from '@agent-device/contracts/observability';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import type { LeaseRegistry } from '../../resources/lease-registry.ts';
import {
  leaseReleaseRequestFor,
  normalizeLeaseBackend,
  type ReleaseLeaseRequest,
} from '../../resources/lease-registry-scope.ts';
import type { SessionStore } from '../../core/session-store.ts';
import {
  isProxyLeaseScope,
  resolveLeaseScope,
  resolveRequestOrSessionLeaseScope,
} from '../../core/lease-context.ts';
import {
  leaseDeviceKey,
  leaseProviderRequiringRuntime,
  leaseScopeToAllocateRequest,
  leaseScopeToHeartbeatRequest,
  leaseScopeToReleaseRequest,
  type LeaseScope,
} from '@agent-device/contracts/lease-scope';
import { publicPlatformString } from '@agent-device/kernel/device';
import { platformForLeaseBackend } from '@agent-device/kernel/contracts';
import { AppError, createRequestCanceledError, errorMessage } from '@agent-device/kernel/errors';
import { LEASE_ALLOCATION_BUDGET_MS } from '@agent-device/command-registry/timeout-policy';
import { getRequestSignal, isRequestCanceled } from '@agent-device/host-kit/request';
import { listDownloadableArtifacts } from '../../resources/artifact-tracking.ts';
import { providerSessionIdFromData } from '../../resources/provider-session-ownership.ts';
import type { DaemonProviderCredentials } from '@agent-device/daemon-contracts/provider-credentials';
import { shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';

type LeaseHandlerArgs = {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  providerRuntimeIds?: readonly string[];
  providerCredentials?: DaemonProviderCredentials;
  leaseLifecycleProvider?: LeaseLifecycleProvider;
  cloudArtifactProvider?: CloudArtifactProvider;
  endSessionsForLease?: (leaseId: string) => Promise<void>;
};

export async function handleLeaseCommands(args: LeaseHandlerArgs): Promise<DaemonResponse | null> {
  const {
    req,
    sessionName,
    sessionStore,
    leaseRegistry,
    providerRuntimeIds,
    providerCredentials,
    leaseLifecycleProvider,
    cloudArtifactProvider,
    endSessionsForLease,
  } = args;
  const leaseScope = resolveLeaseScope(req);
  switch (req.command) {
    case PUBLIC_COMMANDS.artifacts: {
      const artifactScope = resolveRequestOrSessionLeaseScope(req, sessionStore.get(sessionName));
      return {
        ok: true,
        data: (await listArtifactsForRequest(
          req,
          artifactScope,
          leaseRegistry,
          cloudArtifactProvider,
        )) as Record<string, unknown>,
      };
    }
    case 'lease_allocate': {
      assertTenantMayAllocate(leaseScope.leaseBackend);
      assertProviderRuntimeRegistered(leaseScope, providerRuntimeIds ?? []);
      assertProviderCredentialsUnchanged(
        leaseScope,
        req.meta?.providerCredentialFingerprint,
        providerCredentials,
      );
      const { lease, reused } = await allocateOrRenewLease(req, leaseScope, leaseRegistry);
      const requestId = req.meta?.requestId;
      return await leaseRegistry.runDeviceMutation(lease, async () => {
        let providerData: Record<string, unknown> | undefined;
        // A hosted provider can take longer than the lease TTL to create its session; the work
        // pass keeps the lease alive until it does, and ending the pass restarts the TTL then.
        const work = leaseLifecycleProvider?.allocate
          ? leaseRegistry.retainLeaseWork(lease, () => !isRequestCanceled(requestId))
          : undefined;
        try {
          providerData = await leaseLifecycleProvider?.allocate?.(lease, {
            ...leaseLifecycleContext(req),
            signal: getRequestSignal(requestId),
            deadline: Date.now() + LEASE_ALLOCATION_BUDGET_MS,
          });
          recordProviderSession(leaseRegistry, lease, providerData);
        } catch (error) {
          await settleFailedAllocation(
            lease,
            reused,
            requestId,
            leaseLifecycleProvider,
            leaseRegistry,
          );
          throw error;
        } finally {
          work?.release();
        }
        if (isRequestCanceled(requestId)) {
          // The requester left while the provider was allocating; the lease it
          // produced is real (and billed) and nobody will ever release it.
          throw await releaseAllocationForGoneRequester(
            lease,
            leaseLifecycleProvider,
            leaseRegistry,
          );
        }
        const allocated = leaseRegistry.getLease(leaseReleaseRequestFor(lease)) ?? lease;
        return {
          ok: true,
          data: { lease: allocated, ...(providerData ? { provider: providerData } : {}) },
        };
      });
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
      assertTenantMayRelease(lease);
      const outcome = await leaseRegistry.runDeviceMutation(
        lease,
        async () =>
          await releaseLease(
            leaseRegistry,
            leaseLifecycleProvider,
            lease,
            releaseRequest,
            leaseLifecycleContext(req),
          ),
      );
      // Outside the device mutation: ending a session waits for its execution locks, and a
      // command holding them may itself be waiting for that mutation.
      if (lease && outcome.registryReleased) await endSessionsForLease?.(lease.leaseId);
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

/**
 * A request repeating the `leaseId` of its own live lease gets that lease back before any device is
 * picked, so a retry neither fails on a device that left the inventory nor binds another one.
 */
async function allocateOrRenewLease(
  req: DaemonRequest,
  scope: LeaseScope,
  leaseRegistry: LeaseRegistry,
): Promise<{ lease: DeviceLease; reused: boolean }> {
  const request = leaseScopeToAllocateRequest(scope);
  const renewed = leaseRegistry.renewRequestedLease(request);
  if (renewed) return { lease: renewed, reused: true };
  const pickedDeviceKey = await pickProxyLeaseDeviceKey(req, scope);
  const activeLeaseIds = new Set(leaseRegistry.listActiveLeases().map((entry) => entry.leaseId));
  const lease = leaseRegistry.allocateLease(
    pickedDeviceKey ? { ...request, deviceKey: pickedDeviceKey } : request,
  );
  return { lease, reused: activeLeaseIds.has(lease.leaseId) };
}

/**
 * A proxy allocation that names no `deviceKey` but does name a device spec leaves the device to this
 * daemon: it resolves the request's selectors as a command would, and the lease binds that device.
 */
async function pickProxyLeaseDeviceKey(
  req: DaemonRequest,
  scope: LeaseScope,
): Promise<string | undefined> {
  if (!isProxyLeaseScope(scope) || scope.deviceKey) return undefined;
  const flags = req.flags ?? {};
  const { hasDeviceSelectionInput } = await import('../../core/device/device-selector-intent.ts');
  if (!hasDeviceSelectionInput(flags)) return undefined;
  const { resolveTargetDevice } = await import('@agent-device/device-selection/dispatch-resolve');
  const device = await resolveTargetDevice({
    platform:
      flags.platform ??
      (scope.leaseBackend ? platformForLeaseBackend(scope.leaseBackend) : undefined),
    target: flags.target,
    device: flags.device,
    udid: flags.udid,
    serial: flags.serial,
    iosSimulatorDeviceSet: flags.iosSimulatorDeviceSet,
    androidDeviceAllowlist: flags.androidDeviceAllowlist,
  });
  return leaseDeviceKey({
    platform: publicPlatformString(device),
    target: device.target,
    id: device.id,
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
  if (lease) recordProviderSession(leaseRegistry, lease, provider);
  return { registryReleased: leaseRegistry.releaseLease(request).released, provider };
}

// A run's repeat allocation reuses its live lease; refusing that request must not end the
// lease, or the provider session the first allocation created is left without an owner.
// A requester that hung up owns nothing, so its canceled repeat allocation still releases.
async function settleFailedAllocation(
  lease: DeviceLease,
  reused: boolean,
  requestId: string | undefined,
  leaseLifecycleProvider: LeaseLifecycleProvider | undefined,
  leaseRegistry: LeaseRegistry,
): Promise<void> {
  if (!reused) {
    leaseRegistry.releaseLease(leaseReleaseRequestFor(lease));
    return;
  }
  if (isRequestCanceled(requestId)) {
    throw await releaseAllocationForGoneRequester(lease, leaseLifecycleProvider, leaseRegistry);
  }
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
    ...(typeof req.flags?.providerApp === 'string' ? { initialApp: req.flags.providerApp } : {}),
    cwd: typeof req.meta?.cwd === 'string' ? req.meta.cwd : undefined,
    ...(req.internal?.publicNetworkOnly ? { publicNetworkOnly: true } : {}),
  };
}

function assertProviderRuntimeRegistered(
  leaseScope: LeaseScope,
  registeredProviders: readonly string[],
): void {
  const provider = leaseProviderRequiringRuntime(leaseScope);
  if (provider === undefined || registeredProviders.includes(provider)) return;
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    `Provider "${provider}" is not available in this daemon runtime.`,
    {
      reason: 'provider-not-registered',
      provider,
      registeredProviders: [...registeredProviders],
      hint: `Restart the daemon with ${provider} configured, then retry lease allocation.`,
    },
  );
}

function assertProviderCredentialsUnchanged(
  {
    leaseProvider: provider,
    leaseBackend,
  }: Pick<ReturnType<typeof resolveLeaseScope>, 'leaseProvider' | 'leaseBackend'>,
  requested: string | undefined,
  daemon: DaemonProviderCredentials | undefined,
): void {
  if (!daemon || !provider || !requested) return;
  const current = daemon.fingerprint(provider, leaseBackend);
  if (requested === current) return;
  throw new AppError(
    'INVALID_ARGS',
    current
      ? `The running daemon holds different ${provider} credentials than this shell.`
      : `The running daemon was started without the ${provider} credentials this shell holds.`,
    {
      reason: 'provider-credentials-changed',
      provider,
      hint: `Stop it with agent-device daemon stop --state-dir ${shellQuoteIfNeeded(daemon.stateDir)}, then rerun the command so a new daemon starts with this shell's environment.`,
    },
  );
}

async function listArtifactsForRequest(
  req: DaemonRequest,
  leaseScope: ReturnType<typeof resolveLeaseScope>,
  leaseRegistry: LeaseRegistry,
  cloudArtifactProvider: CloudArtifactProvider | undefined,
): Promise<AgentArtifactsResult> {
  const providerSessionId = readFlagString(req.flags, 'providerSessionId');
  if (shouldListDaemonArtifacts(leaseScope, providerSessionId)) {
    return await listDaemonArtifacts(leaseScope.tenantId);
  }

  return await listCloudArtifactsForRequest(
    leaseScope,
    providerSessionId,
    leaseRegistry,
    cloudArtifactProvider,
  );
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
  leaseRegistry: LeaseRegistry,
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
  const providerSession = resolveProviderSession(leaseRegistry, leaseScope, providerSessionId);
  const result = await cloudArtifactProvider?.listCloudArtifacts?.({
    provider: leaseScope.leaseProvider,
    leaseId: providerSession?.leaseId ?? leaseScope.leaseId,
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

function resolveProviderSession(
  leaseRegistry: LeaseRegistry,
  leaseScope: ReturnType<typeof resolveLeaseScope>,
  providerSessionId: string | undefined,
): ReturnType<LeaseRegistry['resolveProviderSession']> {
  if (!providerSessionId) return undefined;
  const providerSession = leaseRegistry.resolveProviderSession({
    provider: leaseScope.leaseProvider,
    providerSessionId,
    tenantId: leaseScope.tenantId,
  });
  if (providerSession) return providerSession;
  throw new AppError('UNAUTHORIZED', 'Provider session is not owned by the request tenant', {
    reason: 'PROVIDER_SESSION_NOT_OWNED',
  });
}

function readFlagString(
  flags: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = flags?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function recordProviderSession(
  leaseRegistry: LeaseRegistry,
  lease: DeviceLease,
  providerData: Record<string, unknown> | undefined,
): void {
  const providerSessionId = providerSessionIdFromData(providerData);
  if (!providerSessionId) return;
  leaseRegistry.recordProviderSession(lease, providerSessionId);
}

/** The host that allocated a `macos-app` lease keeps it for the hosted app's lifetime and ends it with DELETE /admin/leases. */
function assertTenantMayRelease(lease: DeviceLease | undefined): void {
  if (lease?.backend !== 'macos-app') return;
  throw new AppError('UNAUTHORIZED', 'A macos-app lease is released by the host administrator.', {
    reason: 'MACOS_APP_LEASE_HOST_OWNED',
    retriable: false,
    hint: 'Disconnect only drops the client connection; the host ends the lease.',
  });
}

/** A `macos-app` lease names the app it confines a client to, so only the host allocates one. */
function assertTenantMayAllocate(leaseBackend: string | undefined): void {
  if (normalizeLeaseBackend(leaseBackend) !== 'macos-app') return;
  throw new AppError('UNAUTHORIZED', 'A macos-app lease is allocated by the host administrator.', {
    reason: 'MACOS_APP_LEASE_HOST_ALLOCATED',
    retriable: false,
    hint: 'Ask the host administrator for a macos-app lease and connect with its leaseId.',
  });
}
