import { providerRuntimeAdmissionError } from '../provider-runtime-admission.ts';
import {
  recordProviderSession,
  releaseLease,
  type LeaseReleaseOutcome,
} from '../../resources/lease-release.ts';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { LeaseEndReason } from '../lease-lifecycle.ts';
import { resolveRequestSessionRef, type ResolveRequestSessionRef } from '../request-admission.ts';
import type { EnvMap, HostEnvironment } from '@agent-device/kernel/source-value';
import type { PluginInventoryEntry } from '@agent-device/contracts/plugin-inventory';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type {
  DeviceLease,
  DevicePin,
  LeaseLifecycleContext,
  LeaseLifecycleProvider,
} from '@agent-device/contracts/device';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type {
  AgentArtifactsResult,
  CloudArtifactProvider,
} from '@agent-device/contracts/observability';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import { requestCwd } from '../../core/context.ts';
import type { LeaseRegistry } from '../../resources/lease-registry.ts';
import {
  leaseReleaseRequestFor,
  normalizeDeviceKey,
  normalizeLeaseBackend,
  normalizeRequiredLeaseId,
} from '../../resources/lease-registry-scope.ts';
import type { SessionStore } from '../../core/session-store.ts';
import {
  assertRequestPresentsLease,
  isProxyLeaseScope,
  resolveLeaseScope,
  resolveSessionLeaseScope,
} from '../../core/lease-context.ts';
import {
  isProviderInstanceEndedError,
  leaseDeviceKey,
  leaseProviderRequiringRuntime,
  leaseScopeToAllocateRequest,
  leaseScopeToHeartbeatRequest,
  leaseScopeToReleaseRequest,
  type LeaseScope,
} from '@agent-device/contracts/lease-scope';
import { publicPlatformString } from '@agent-device/kernel/device';
import { normalizeLeaseProvider, platformForLeaseBackend } from '@agent-device/kernel/contracts';
import {
  AppError,
  createRequestCanceledError,
  errorMessage,
  type ReasonTable,
} from '@agent-device/kernel/errors';
import { LEASE_ALLOCATION_BUDGET_MS } from '@agent-device/command-registry/timeout-policy';
import { getRequestSignal, isRequestCanceled } from '@agent-device/host-kit/request';
import { listDownloadableArtifacts } from '../../resources/artifact-tracking.ts';
import type { DaemonProviderCredentials } from '@agent-device/daemon-contracts/provider-credentials';
import { shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';

const LEASE_HANDLER_REASONS = {
  // The running daemon holds different provider credentials than this shell; stop the daemon and
  // rerun.
  providerCredentialsChanged: { reason: 'provider-credentials-changed' },
  // The provider session belongs to another tenant.
  providerSessionNotOwned: { reason: 'PROVIDER_SESSION_NOT_OWNED' },
  // Only the host administrator releases a `macos-app` lease.
  macOsAppHostOwned: { reason: 'MACOS_APP_LEASE_HOST_OWNED' },
  // Only the host administrator allocates a `macos-app` lease.
  macOsAppHostAllocated: { reason: 'MACOS_APP_LEASE_HOST_ALLOCATED' },
} as const satisfies ReasonTable<'leases'>;

type LeaseHandlerArgs = {
  host: HostEnvironment;
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  resolveSessionRef?: ResolveRequestSessionRef;
  leaseRegistry: LeaseRegistry;
  providerRuntimeIds?: readonly string[];
  pluginInventory?: readonly PluginInventoryEntry[];
  providerCredentials?: DaemonProviderCredentials;
  leaseLifecycleProvider?: LeaseLifecycleProvider;
  cloudArtifactProvider?: CloudArtifactProvider;
  endSessionsForLease?: (leaseId: string, reason?: LeaseEndReason) => Promise<void>;
};

export async function handleLeaseCommands(args: LeaseHandlerArgs): Promise<DaemonResponse | null> {
  const {
    req,
    sessionName,
    sessionStore,
    leaseRegistry,
    providerRuntimeIds,
    pluginInventory,
    providerCredentials,
    leaseLifecycleProvider,
    cloudArtifactProvider,
    endSessionsForLease,
  } = args;
  const leaseScope = resolveLeaseScope(req);
  switch (req.command) {
    case PUBLIC_COMMANDS.artifacts: {
      const resolveSessionRef = args.resolveSessionRef ?? resolveRequestSessionRef;
      const ref = resolveSessionRef(req, sessionStore.lookup(sessionName));
      const artifactScope = resolveSessionLeaseScope(req, ref?.session);
      return {
        ok: true,
        data: (await listArtifactsForRequest(
          req,
          artifactScope,
          leaseRegistry,
          cloudArtifactProvider,
          args.host.env,
        )) as Record<string, unknown>,
      };
    }
    case 'lease_allocate': {
      assertTenantMayAllocate(leaseScope.leaseBackend);
      // The registry stores the trimmed, validated id, so every admission check reads that id:
      // " testmu " names testmu, and a malformed id is INVALID_ARGS as everywhere else.
      const leaseProvider = normalizeLeaseProvider(leaseScope.leaseProvider);
      const provider = leaseProviderRequiringRuntime({ leaseProvider });
      if (provider !== undefined) {
        const error = providerRuntimeAdmissionError(
          provider,
          'allocation',
          providerRuntimeIds,
          pluginInventory,
        );
        if (error) throw error;
      }
      assertProviderCredentialsUnchanged(
        { leaseProvider, leaseBackend: leaseScope.leaseBackend },
        req.meta?.providerCredentialFingerprint,
        providerCredentials,
      );
      const { lease, reused } = await allocateOrRenewLease(
        req,
        { ...leaseScope, leaseProvider },
        leaseRegistry,
        args.host,
      );
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
            ...leaseLifecycleContext(req, args.host),
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
          data: {
            lease: allocated,
            // Whether this request was handed a lease that already existed. A caller that may end
            // the lease needs this: the returned lease alone does not say who created it.
            reused,
            ...(providerData ? { provider: providerData } : {}),
          },
        };
      });
    }
    case 'lease_heartbeat':
      return await heartbeatLease(args, leaseScope);
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
            leaseLifecycleContext(req, args.host),
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
 * Unpinned retries can renew a lease whose device left the inventory.
 * Pinned proxy retries must admit the existing device before renewing it.
 */
async function allocateOrRenewLease(
  req: DaemonRequest,
  scope: LeaseScope,
  leaseRegistry: LeaseRegistry,
  host: HostEnvironment,
): Promise<{ lease: DeviceLease; reused: boolean }> {
  const request = leaseScopeToAllocateRequest(scope);
  const pinnedProxy = req.meta?.devicePin && isProxyLeaseScope(scope);
  const renewed = pinnedProxy ? undefined : leaseRegistry.renewRequestedLease(request);
  if (renewed) return { lease: renewed, reused: true };
  const existingId =
    pinnedProxy && scope.leaseId ? normalizeRequiredLeaseId(scope.leaseId) : undefined;
  const existing = existingId
    ? leaseRegistry.listActiveLeases().find((lease) => lease.leaseId === existingId)
    : undefined;
  const pickedDeviceKey = await pickProxyLeaseDeviceKey(
    req,
    { ...scope, deviceKey: normalizeDeviceKey(scope.deviceKey) ?? existing?.deviceKey },
    host.env,
  );
  const activeLeaseIds = new Set(leaseRegistry.listActiveLeases().map((entry) => entry.leaseId));
  const lease = leaseRegistry.allocateLease(
    pickedDeviceKey ? { ...request, deviceKey: pickedDeviceKey } : request,
  );
  return { lease, reused: activeLeaseIds.has(lease.leaseId) };
}

async function pickProxyLeaseDeviceKey(
  req: DaemonRequest,
  scope: LeaseScope,
  env: EnvMap,
): Promise<string | undefined> {
  const pin = req.meta?.devicePin;
  if (!isProxyLeaseScope(scope) || (scope.deviceKey && !pin)) return undefined;
  const pinPolicy = pin
    ? await import('@agent-device/device-selection/device-selection-resolver')
    : undefined;
  const requested = req.flags ?? {};
  const selector =
    pin && pinPolicy ? pinPolicy.effectiveDevicePinSelector(pin, requested) : requested;
  const flags = {
    platform: selector.platform,
    target: requested.target,
    device: selector.device,
    udid: selector.udid,
    serial: selector.serial,
    iosSimulatorDeviceSet: requested.iosSimulatorDeviceSet,
    androidDeviceAllowlist: requested.androidDeviceAllowlist,
  };
  if (scope.deviceKey && pin) {
    return await admitPinnedProxyLeaseDeviceKey(scope.deviceKey, pin, flags, env);
  }
  const { hasDeviceSelectionInput } = await import('../../core/device/device-selector-intent.ts');
  if (!hasDeviceSelectionInput(flags)) return undefined;
  const { resolveTargetDevice } = await import('@agent-device/device-selection/dispatch-resolve');
  const device = await resolveTargetDevice(
    {
      ...flags,
      platform:
        flags.platform ??
        (scope.leaseBackend ? platformForLeaseBackend(scope.leaseBackend) : undefined),
    },
    { env },
  );
  if (pin && pinPolicy) pinPolicy.assertDeviceHonorsPin(pin, device, flags);
  return leaseDeviceKey({
    platform: publicPlatformString(device),
    target: device.target,
    id: device.id,
  });
}

async function admitPinnedProxyLeaseDeviceKey(
  deviceKey: string,
  pin: DevicePin,
  flags: NonNullable<DaemonRequest['flags']>,
  env: EnvMap,
): Promise<string> {
  const { listDeviceInventory } =
    await import('@agent-device/device-selection/device-inventory-context');
  const { buildDeviceInventoryRequestFromFlags } =
    await import('@agent-device/device-selection/dispatch-resolve');
  const { assertDeviceHonorsPin } =
    await import('@agent-device/device-selection/device-selection-resolver');
  const devices = await listDeviceInventory(buildDeviceInventoryRequestFromFlags(flags, env));
  const device = devices.find(
    (device) => leaseDeviceKey({ ...device, platform: publicPlatformString(device) }) === deviceKey,
  );
  if (!device) {
    throw new AppError(
      'INVALID_ARGS',
      'The lease device key does not match an available pinned device.',
      {
        reason: 'device_pin_conflict',
        pin: pin.selector,
        pinSource: `${pin.source.kind === 'project' ? 'project ' : ''}config file ${pin.source.path}`,
        deviceKey,
      },
    );
  }
  assertDeviceHonorsPin(pin, device, flags);
  return deviceKey;
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

async function heartbeatLease(
  args: LeaseHandlerArgs,
  leaseScope: LeaseScope,
): Promise<DaemonResponse> {
  const { leaseRegistry, leaseLifecycleProvider, req, endSessionsForLease } = args;
  const lease = leaseRegistry.heartbeatLease(leaseScopeToHeartbeatRequest(leaseScope));
  let providerData: Record<string, unknown> | undefined;
  const isCurrent = leaseRegistry.pinActiveLease(lease.leaseId);
  let ended: AppError | undefined;
  let endWon = false;
  try {
    providerData = await leaseLifecycleProvider?.heartbeat?.(lease, {
      ...leaseLifecycleContext(req, args.host),
      signal: getRequestSignal(req.meta?.requestId),
    });
  } catch (error) {
    if (!(error instanceof AppError) || !isProviderInstanceEndedError(error)) throw error;
    endWon = isCurrent() && leaseRegistry.endProviderLease(leaseReleaseRequestFor(lease));
    ended = error;
  }
  if (ended) {
    // The client stops beating only on the typed reason, so a failed teardown must not replace it.
    try {
      if (endWon) await endSessionsForLease?.(lease.leaseId, 'PROVIDER_INSTANCE_ENDED');
    } catch (error) {
      emitDiagnostic({
        level: 'warn',
        phase: 'lease_provider_ended_session_teardown_failed',
        data: {
          leaseId: lease.leaseId,
          error: errorMessage(error),
        },
      });
    }
    throw ended;
  }
  return {
    ok: true,
    data: { lease, ...(providerData ? { provider: providerData } : {}) },
  };
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

function leaseLifecycleContext(req: DaemonRequest, host: HostEnvironment): LeaseLifecycleContext {
  return {
    flags: req.flags,
    ...(typeof req.flags?.providerApp === 'string' ? { initialApp: req.flags.providerApp } : {}),
    cwd: requestCwd(req, host),
    ...(req.internal?.publicNetworkOnly ? { publicNetworkOnly: true } : {}),
  };
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
      reason: LEASE_HANDLER_REASONS.providerCredentialsChanged.reason,
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
  hostEnv: NodeJS.ProcessEnv,
): Promise<AgentArtifactsResult> {
  const providerSessionId = readFlagString(req.flags, 'providerSessionId');
  if (shouldListDaemonArtifacts(leaseScope, providerSessionId)) {
    return await listDaemonArtifacts(leaseScope, hostEnv);
  }

  return await listCloudArtifactsForRequest(
    req,
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

async function listDaemonArtifacts(
  reader: Pick<LeaseScope, 'tenantId' | 'leaseId'>,
  hostEnv: NodeJS.ProcessEnv,
): Promise<AgentArtifactsResult> {
  const artifacts = await listDownloadableArtifacts(reader, hostEnv);
  return {
    source: 'daemon',
    status: 'ready',
    artifacts,
    ...(artifacts.length === 0 ? { message: 'No daemon artifacts available.' } : {}),
  };
}

async function listCloudArtifactsForRequest(
  req: DaemonRequest,
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
  // A presented active lease id is checked with its labels first, before any tenant-filtered lookup.
  const activeLeaseId = leaseScope.leaseId
    ? assertRequestHoldsActiveProviderLease(leaseRegistry, req, leaseScope.leaseId)
    : undefined;
  const providerSession = resolveProviderSession(req, leaseRegistry, leaseScope, providerSessionId);
  const result = await cloudArtifactProvider?.listCloudArtifacts?.({
    provider: leaseScope.leaseProvider,
    leaseId: providerSession?.leaseId ?? activeLeaseId ?? leaseScope.leaseId,
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
  req: DaemonRequest,
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
  if (providerSession) {
    assertRequestHoldsActiveProviderLease(leaseRegistry, req, providerSession.leaseId);
    return providerSession;
  }
  throw new AppError('UNAUTHORIZED', 'Provider session is not owned by the request tenant', {
    reason: LEASE_HANDLER_REASONS.providerSessionNotOwned.reason,
  });
}

/**
 * While its lease is active, a provider session belongs to the client that holds that lease: the
 * lookup needs the lease id and matching labels, as any request on the leased session does
 * (ADR 0007). A released provider session keeps its tenant-scoped retention lookup. Returns the
 * active lease's canonical id.
 */
function assertRequestHoldsActiveProviderLease(
  leaseRegistry: LeaseRegistry,
  req: DaemonRequest,
  leaseId: string,
): string | undefined {
  const lease = leaseRegistry.inspectActiveLease(leaseId);
  if (!lease) return undefined;
  assertRequestPresentsLease(req, lease);
  return lease.leaseId;
}

function readFlagString(
  flags: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = flags?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** The host that allocated a `macos-app` lease keeps it for the hosted app's lifetime and ends it with DELETE /admin/leases. */
function assertTenantMayRelease(lease: DeviceLease | undefined): void {
  if (lease?.backend !== 'macos-app') return;
  throw new AppError('UNAUTHORIZED', 'A macos-app lease is released by the host administrator.', {
    reason: LEASE_HANDLER_REASONS.macOsAppHostOwned.reason,
    retriable: false,
    hint: 'Disconnect only drops the client connection; the host ends the lease.',
  });
}

/** A `macos-app` lease names the app it confines a client to, so only the host allocates one. */
function assertTenantMayAllocate(leaseBackend: string | undefined): void {
  if (normalizeLeaseBackend(leaseBackend) !== 'macos-app') return;
  throw new AppError('UNAUTHORIZED', 'A macos-app lease is allocated by the host administrator.', {
    reason: LEASE_HANDLER_REASONS.macOsAppHostAllocated.reason,
    retriable: false,
    hint: 'Ask the host administrator for a macos-app lease and connect with its leaseId.',
  });
}
