import type { RequestProgressSink } from '@agent-device/contracts/progress';
import type {
  DaemonRequest as SharedDaemonRequest,
  DaemonResponse as SharedDaemonResponse,
} from '../daemon/daemon-request.ts';
import type { AgentDeviceDaemonTransportContext } from '@agent-device/contracts/client';
import { AppError } from '@agent-device/kernel/errors';
import {
  createRequestId,
  emitDiagnostic,
  withDiagnosticTimer,
} from '@agent-device/host-kit/diagnostics';
import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { resolveCommandTimeoutPolicy } from '@agent-device/command-registry/registry';
import { resolveCommandRequestTimeoutMs } from '@agent-device/command-registry/timeout-policy';
import {
  prepareRemoteRequestArtifacts,
  type PreparedRemoteRequest,
} from '../remote/daemon-artifacts.ts';
import type { DaemonClientSettings, EnsuredDaemon } from './daemon-client-lifecycle.ts';
import { createRequestGuard, sendRequest } from './daemon-client-transport.ts';
import { isRemoteDaemon, type DaemonInfo } from './daemon-client-metadata.ts';
import { leaseScopeFromRequest } from '@agent-device/contracts/lease-scope';

export type DaemonRequest = SharedDaemonRequest;
export type DaemonResponse = SharedDaemonResponse;
type DaemonTransportOptions = AgentDeviceDaemonTransportContext & {
  onProgress?: RequestProgressSink;
};

export async function sendToDaemon(
  req: Omit<DaemonRequest, 'token'>,
  options: DaemonTransportOptions = {},
): Promise<DaemonResponse> {
  const { resolveClientSettings, ensureDaemon, attachSessionAddressHints } =
    await import('./daemon-client-lifecycle.ts');
  const requestId = req.meta?.requestId ?? createRequestId();
  const debug = Boolean(req.meta?.debug || req.flags?.verbose);
  // A few internal callers build DaemonRequest directly instead of using the
  // public client flag builder. Defend this transport boundary too: credentials
  // belong in the auth channel, never in serializable request flags.
  const rawFlags = req.flags as
    | (NonNullable<typeof req.flags> & { daemonAuthToken?: string })
    | undefined;
  const { daemonAuthToken: flagAuthToken, ...flags } = rawFlags ?? {};
  const requestWithoutAuthFlag = rawFlags ? { ...req, flags } : req;
  const settings = resolveClientSettings(
    requestWithoutAuthFlag,
    options.authToken ?? flagAuthToken,
  );
  const requestTimeoutMs = resolveCommandRequestTimeoutMs(
    resolveCommandTimeoutPolicy(requestWithoutAuthFlag.command),
    requestWithoutAuthFlag,
  );
  // The caller's signal covers every phase of this one request, and the guard turns any phase's
  // cancellation into the typed canceled-request error — so an abort never borrows a timeout's shape.
  const cancellation = createRequestGuard({ signal: options.signal, requestId });
  cancellation.refuseIfAborted();
  const daemon = await cancellation.guard(async () => {
    return await withDiagnosticTimer('daemon_startup', async () => await ensureDaemon(settings), {
      requestId,
      session: req.session,
    });
  });
  const info = daemon.info;
  const preparedRemoteRequest = await cancellation.guard(
    async () =>
      await protectArtifactUploadWithLeaseBeats(
        info,
        settings,
        requestWithoutAuthFlag,
        options.signal,
      ),
  );
  writeInstallInProgressNotice(requestWithoutAuthFlag.command);

  const request = buildTransportRequest(
    requestWithoutAuthFlag,
    preparedRemoteRequest,
    info,
    requestId,
    debug,
    await readLocalProviderCredentialFingerprint(requestWithoutAuthFlag, info),
  );
  emitDiagnostic({
    level: 'info',
    phase: 'daemon_request_prepare',
    data: {
      requestId,
      command: requestWithoutAuthFlag.command,
      session: requestWithoutAuthFlag.session,
    },
  });
  return await performDaemonRequestWithCleanup(
    requestWithoutAuthFlag,
    daemon,
    settings,
    async () => {
      const response = await withDiagnosticTimer(
        'daemon_request',
        async () =>
          await sendRequest(
            info,
            request,
            settings.transportPreference,
            settings.paths,
            requestTimeoutMs,
            { onProgress: options.onProgress, signal: options.signal },
          ),
        { requestId, command: req.command },
      );
      return attachSessionAddressHints(response, requestWithoutAuthFlag, settings);
    },
  );
}

function buildTransportRequest(
  request: Omit<DaemonRequest, 'token'>,
  preparedRemoteRequest: Awaited<ReturnType<typeof prepareRemoteRequestArtifacts>>,
  info: DaemonInfo,
  requestId: string,
  debug: boolean,
  providerCredentialFingerprint: string | undefined,
): DaemonRequest {
  return {
    ...request,
    positionals: preparedRemoteRequest.positionals,
    flags: preparedRemoteRequest.flags,
    token: info.token,
    meta: {
      ...buildTransportRequestMeta(request, preparedRemoteRequest, requestId, debug),
      ...buildLocalHostEnvMeta(info),
      providerCredentialFingerprint,
    },
  };
}

// A remote daemon reads provider credentials from its own host, so only a local daemon is asked
// to compare them, and only when a lease is allocated.
async function readLocalProviderCredentialFingerprint(
  request: Omit<DaemonRequest, 'token'>,
  info: DaemonInfo,
): Promise<string | undefined> {
  if (isRemoteDaemon(info) || request.command !== 'lease_allocate') return undefined;
  const { leaseProvider: provider, leaseBackend } = leaseScopeFromRequest(request);
  if (!provider) return undefined;
  const { providerCredentialFingerprint } = await import('../provider-credential-fingerprint.ts');
  return providerCredentialFingerprint(provider, process.env, leaseBackend);
}

// A developer dir is a path on the client's host, so only a local daemon can use it.
function buildLocalHostEnvMeta(
  info: DaemonInfo,
): Pick<NonNullable<DaemonRequest['meta']>, 'developerDir'> {
  const developerDir = process.env.DEVELOPER_DIR;
  if (isRemoteDaemon(info)) return { developerDir: undefined };
  return developerDir !== undefined ? { developerDir } : {};
}

function buildTransportRequestMeta(
  request: Omit<DaemonRequest, 'token'>,
  preparedRemoteRequest: Awaited<ReturnType<typeof prepareRemoteRequestArtifacts>>,
  requestId: string,
  debug: boolean,
): NonNullable<DaemonRequest['meta']> {
  const meta = request.meta ?? {};
  return {
    ...meta,
    requestId,
    debug,
    ...buildRequestScopeMeta(meta, request.flags),
    ...buildRemoteArtifactMeta(preparedRemoteRequest),
  };
}

function buildRequestScopeMeta(
  meta: NonNullable<DaemonRequest['meta']>,
  flags: DaemonRequest['flags'],
): Pick<
  NonNullable<DaemonRequest['meta']>,
  | 'includeCost'
  | 'cwd'
  | 'sessionExplicit'
  | 'tenantId'
  | 'runId'
  | 'leaseId'
  | 'sessionIsolation'
  | 'lockPolicy'
  | 'lockPlatform'
> {
  return {
    includeCost: meta.includeCost,
    cwd: meta.cwd,
    sessionExplicit: meta.sessionExplicit,
    tenantId: meta.tenantId ?? flags?.tenant,
    runId: meta.runId ?? flags?.runId,
    leaseId: meta.leaseId ?? flags?.leaseId,
    sessionIsolation: meta.sessionIsolation ?? flags?.sessionIsolation,
    lockPolicy: meta.lockPolicy,
    lockPlatform: meta.lockPlatform,
  };
}

function buildRemoteArtifactMeta(
  preparedRemoteRequest: Awaited<ReturnType<typeof prepareRemoteRequestArtifacts>>,
): Pick<
  NonNullable<DaemonRequest['meta']>,
  'uploadedArtifactId' | 'clientArtifactPaths' | 'installSource'
> {
  return {
    ...(preparedRemoteRequest.uploadedArtifactId
      ? { uploadedArtifactId: preparedRemoteRequest.uploadedArtifactId }
      : {}),
    ...(preparedRemoteRequest.clientArtifactPaths
      ? { clientArtifactPaths: preparedRemoteRequest.clientArtifactPaths }
      : {}),
    ...(preparedRemoteRequest.installSource
      ? { installSource: preparedRemoteRequest.installSource }
      : {}),
  };
}

/**
 * ADR 0012 decision 6 (BLOCKER 2, third follow-up): runs `send` and ALWAYS
 * runs cleanup afterward, using cleanup's result (not `send`'s raw result) as
 * the response the caller actually receives — cleanup can discover a
 * shutdown-time repair-commit failure the request itself never knew about (a
 * one-shot repair that completed with no divergence returns SUCCESS
 * immediately; the actual commit is deferred to daemon teardown, which
 * `cleanupDaemonAfterRequest` triggers and inspects). A caught-and-rethrown
 * error (rather than a `return` inside `finally`, which oxlint's
 * `no-unsafe-finally` rejects and which would also make a thrown `send`
 * failure silently swallowed by a later `return`) keeps cleanup running
 * unconditionally while a thrown failure still propagates normally afterward.
 */
async function performDaemonRequestWithCleanup(
  req: Omit<DaemonRequest, 'token'>,
  daemon: EnsuredDaemon,
  settings: DaemonClientSettings,
  send: () => Promise<DaemonResponse>,
): Promise<DaemonResponse> {
  let response: DaemonResponse | undefined;
  let requestFailed = false;
  let requestError: unknown;
  try {
    response = await send();
  } catch (error) {
    requestFailed = true;
    requestError = error;
  }
  const { cleanupDaemonAfterRequest } = await import('./daemon-client-lifecycle.ts');
  const finalResponse = await cleanupDaemonAfterRequest(req, daemon, settings, response);
  if (requestFailed) throw requestError;
  if (!finalResponse) {
    // Unreachable in practice: `requestFailed` is false here, so `response`
    // was successfully set above, and `cleanupDaemonAfterRequest` always
    // returns a response (unchanged or overridden) when given one.
    throw new AppError('COMMAND_FAILED', 'Daemon request produced no response after cleanup');
  }
  return finalResponse;
}

function writeInstallInProgressNotice(command: string | undefined): void {
  if (!isInstallLikeCommand(command) || process.stderr.isTTY !== true || process.env.CI) return;
  process.stderr.write(
    command === PUBLIC_COMMANDS.reinstall ? 'Reinstalling...\n' : 'Installing...\n',
  );
}

function isInstallLikeCommand(command: string | undefined): boolean {
  return (
    command === PUBLIC_COMMANDS.install ||
    command === PUBLIC_COMMANDS.reinstall ||
    command === INTERNAL_COMMANDS.installSource
  );
}

/**
 * Uploads a remote request's artifact under a lease beat, so a large artifact cannot outlive the
 * lease paying for the device it is going to (#2946).
 *
 * Only a remote daemon uploads, and a request that names no lease has nothing to renew, so those two
 * guards answer for the overwhelming majority of requests — and they are what let the beat module
 * stay out of `cli.ts`'s eager closure, which every command pays for. Both are cheap and local: the
 * lease scope is read from the request the caller already built.
 */
async function protectArtifactUploadWithLeaseBeats(
  info: DaemonInfo,
  settings: DaemonClientSettings,
  request: Omit<DaemonRequest, 'token'>,
  callerSignal: AbortSignal | undefined,
): Promise<PreparedRemoteRequest> {
  const leaseScope = leaseScopeFromRequest(request);
  if (!isRemoteDaemon(info) || !leaseScope.leaseId) {
    return await prepareRemoteRequestArtifacts(
      request,
      info,
      callerSignal ?? new AbortController().signal,
    );
  }
  const { buildUploadLeaseHeartbeat, runProtectedLeaseWork } =
    await import('./daemon-client-lease-beat.ts');
  return await runProtectedLeaseWork({
    heartbeat: buildUploadLeaseHeartbeat(info, settings, request),
    // The upload stops for either owner of its signal: the lease beat finding the lease gone, or
    // the caller aborting this one call.
    task: (leaseSignal) =>
      prepareRemoteRequestArtifacts(
        request,
        info,
        callerSignal ? AbortSignal.any([leaseSignal, callerSignal]) : leaseSignal,
      ),
    callerSignal,
  });
}
