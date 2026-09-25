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
import { prepareRemoteRequestArtifacts } from '../remote/daemon-artifacts.ts';
import { isRemoteDaemon } from './daemon-client-metadata.ts';
import {
  leaseScopeFromRequest,
  leaseScopeToRequestMeta,
  type LeaseScope,
} from '@agent-device/contracts/lease-scope';
import {
  attachActiveSessionAddressHint,
  attachRepairSessionAddressHint,
  cleanupDaemonAfterRequest,
  ensureDaemon,
  isActiveReplaySessionResponse,
  isHeldRepairDivergence,
  resolveClientSettings,
  type DaemonClientSettings,
  type EnsuredDaemon,
} from './daemon-client-lifecycle.ts';
import { sendRequest } from './daemon-client-transport.ts';

export type DaemonRequest = SharedDaemonRequest;
export type DaemonResponse = SharedDaemonResponse;
type DaemonTransportOptions = AgentDeviceDaemonTransportContext & {
  onProgress?: RequestProgressSink;
};

export async function sendToDaemon(
  req: Omit<DaemonRequest, 'token'>,
  options: DaemonTransportOptions = {},
): Promise<DaemonResponse> {
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
  const daemon = await withDiagnosticTimer(
    'daemon_startup',
    async () => await ensureDaemon(settings),
    { requestId, session: req.session },
  );
  const info = daemon.info;
  const preparedRemoteRequest = await runProtectedLeaseWork({
    heartbeat: buildUploadLeaseHeartbeat(info, settings, requestWithoutAuthFlag),
    task: () => prepareRemoteRequestArtifacts(requestWithoutAuthFlag, info),
  });
  writeInstallInProgressNotice(requestWithoutAuthFlag.command);

  const request = buildTransportRequest(
    requestWithoutAuthFlag,
    preparedRemoteRequest,
    info.token,
    requestId,
    debug,
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
            options.onProgress ? { onProgress: options.onProgress } : undefined,
          ),
        { requestId, command: req.command },
      );
      return withActiveSessionAddressHint(
        withRepairSessionAddressHintIfOwned(response, settings),
        requestWithoutAuthFlag,
        settings,
      );
    },
  );
}

function buildTransportRequest(
  request: Omit<DaemonRequest, 'token'>,
  preparedRemoteRequest: Awaited<ReturnType<typeof prepareRemoteRequestArtifacts>>,
  token: string,
  requestId: string,
  debug: boolean,
): DaemonRequest {
  return {
    ...request,
    positionals: preparedRemoteRequest.positionals,
    flags: preparedRemoteRequest.flags,
    token,
    meta: buildTransportRequestMeta(request, preparedRemoteRequest, requestId, debug),
  };
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

/**
 * ADR 0012 decision 6 (Fix 1): the owned ephemeral state dir this daemon was
 * started at is otherwise unaddressable by a later invocation — hint it here,
 * only when the daemon is actually being kept alive for it
 * (`settings.ownedStateDir` means `daemon.startedByClient` is also true).
 */
function withRepairSessionAddressHintIfOwned(
  response: DaemonResponse,
  settings: DaemonClientSettings,
): DaemonResponse {
  if (response.ok || !settings.ownedStateDir || !isHeldRepairDivergence(response)) {
    return response;
  }
  return attachRepairSessionAddressHint(response, settings.paths.baseDir);
}

/**
 * ADR 0016 counterpart to `withRepairSessionAddressHintIfOwned` — but unlike
 * that one, NOT gated on `settings.ownedStateDir`. An owned ephemeral state
 * dir is unaddressable by a later invocation either way, so it's included
 * when owned; an explicit `--state-dir`/`AGENT_DEVICE_STATE_DIR` caller
 * already knows their own dir, so it's omitted then. But the session's own
 * name is cwd-qualified and, per #1394, `session list` cannot rediscover it
 * either — so `--session` is still worth hinting even at an explicit state
 * dir, which is why this runs for every active-session response regardless
 * of `ownedStateDir` (`attachActiveSessionAddressHint` itself decides what,
 * if anything, is worth attaching).
 */
function withActiveSessionAddressHint(
  response: DaemonResponse,
  req: Omit<DaemonRequest, 'token'>,
  settings: DaemonClientSettings,
): DaemonResponse {
  if (!response.ok || !isActiveReplaySessionResponse(req, response)) {
    return response;
  }
  return attachActiveSessionAddressHint(
    response,
    settings.ownedStateDir ? settings.paths.baseDir : undefined,
  );
}

/**
 * How often a long client-side phase renews the lease it is waiting under.
 *
 * A third of the daemon's one-minute default inactivity TTL: a beat always lands while two thirds of
 * the window it is protecting is still open, so one slow or lost beat cannot cost the lease.
 */
export const LEASE_HEARTBEAT_INTERVAL_MS = 20_000;

/** Why a beat stopped protecting the lease: the lease is gone, so nothing else is worth waiting for. */
const FATAL_LEASE_BEAT_REASONS: ReadonlySet<unknown> = new Set([
  'LEASE_NOT_FOUND',
  'LEASE_EXPIRED',
  'LEASE_REVOKED',
  'LEASE_SESSION_MISMATCH',
]);

/**
 * Runs one client-side phase under a lease it does not own the clock of.
 *
 * A lease renews when a request is admitted, and the daemon protects a lease while ADMITTED work
 * runs on it (#2509, ADR 0007). An artifact upload is the mirror image: it happens on the caller's
 * side, before the install request that will consume it is admitted, so nothing renews the lease
 * while it runs and a large enough artifact expired the lease that was paying for the device it was
 * being uploaded to (#2946).
 *
 * `heartbeat` is the caller's transport decision; `undefined` means there is no lease to protect and
 * the phase runs untouched. A beat that fails for a reason other than the lease being gone is
 * reported and ignored — one lost request must not fail an upload that a later beat will cover. A
 * beat that finds the lease gone ends the phase immediately with that error: the device is no
 * longer ours, and the only honest outcome is to say so before the bytes finish.
 *
 * Beats never overlap, and an in-flight beat is awaited on the way out so a renewal cannot land
 * after the phase it was protecting.
 */
export async function runProtectedLeaseWork<T>(
  options: Readonly<{
    heartbeat: (() => Promise<unknown>) | undefined;
    intervalMs?: number;
    task: () => Promise<T>;
  }>,
): Promise<T> {
  const { heartbeat } = options;
  if (!heartbeat) return await options.task();
  const intervalMs = options.intervalMs ?? LEASE_HEARTBEAT_INTERVAL_MS;

  let inFlight: Promise<void> | undefined;
  let lostLease: unknown;
  let reportLoss: ((error: unknown) => void) | undefined;
  const lost = new Promise<never>((_, reject) => {
    reportLoss = reject;
  });

  const beat = () => {
    if (inFlight) return;
    inFlight = (async () => {
      try {
        await heartbeat();
      } catch (error) {
        if (!isLostLeaseError(error)) {
          emitDiagnostic({
            level: 'warn',
            phase: 'lease_heartbeat_failed',
            data: { message: error instanceof Error ? error.message : String(error) },
          });
          return;
        }
        lostLease = error;
        reportLoss?.(error);
      } finally {
        inFlight = undefined;
      }
    })();
  };

  const timer = setInterval(beat, intervalMs);
  // A beat already in flight when the phase settles can still report a lost lease; the caller reads
  // it from `lostLease`, so nothing may be left racing on this rejection by then.
  void lost.catch(() => undefined);
  const phase = await captureOutcome(
    // The async boundary also turns a synchronous throw from the phase into a rejection, so the
    // timer below is always cleared.
    (async () => await Promise.race([options.task(), lost]))(),
  );
  clearInterval(timer);
  await inFlight;
  // A beat that found the lease gone outranks a phase that settled meanwhile, from either side: the
  // device is no longer ours, and the lease error is the reason the phase was not worth finishing.
  if (lostLease !== undefined) throw lostLease;
  if (!phase.ok) throw phase.error;
  return phase.value;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function captureOutcome<T>(promise: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

function isLostLeaseError(error: unknown): boolean {
  return error instanceof AppError && FATAL_LEASE_BEAT_REASONS.has(error.details?.reason);
}

/**
 * The beat that keeps a remote lease alive across a long client-side phase.
 *
 * `send` is the caller's transport. The beat goes over it directly rather than through the client's
 * `leases.heartbeat`, because the client would come back through the upload path it protects.
 */
export function createLeaseRenewalBeat(
  leaseScope: LeaseScope,
  context: Readonly<{
    session: string;
    sessionIsolation?: NonNullable<DaemonRequest['meta']>['sessionIsolation'];
    token: string;
    send: (request: DaemonRequest) => Promise<unknown>;
  }>,
): () => Promise<unknown> {
  return async () =>
    await context.send(
      buildLeaseHeartbeatRequest(leaseScope, {
        session: context.session,
        sessionIsolation: context.sessionIsolation,
        requestId: createRequestId(),
        token: context.token,
      }),
    );
}

/**
 * The request one beat sends: the command's lease scope, its own id, and nothing else.
 *
 * It is a fresh request rather than the install rewritten, so nothing about the upload — its source,
 * its positional, its own request id — can be mistaken for the lease's state. The scope rides along
 * as the command named it, so a beat renews for whatever window that command asked for, and for the
 * lease's own window when it named none, which is the ordinary case for an install. Each beat gets a
 * fresh id because a beat that times out is canceled under its own, and a shared id would let a later
 * beat inherit an earlier cancellation.
 */
export function buildLeaseHeartbeatRequest(
  leaseScope: LeaseScope,
  context: Readonly<{
    session: string;
    sessionIsolation?: NonNullable<DaemonRequest['meta']>['sessionIsolation'];
    requestId: string;
    token: string;
  }>,
): DaemonRequest {
  return {
    command: INTERNAL_COMMANDS.leaseHeartbeat,
    positionals: [],
    session: context.session,
    token: context.token,
    meta: {
      ...leaseScopeToRequestMeta(leaseScope),
      sessionIsolation: context.sessionIsolation,
      requestId: context.requestId,
    },
  };
}

/** The lease a request is running under, when it names one. */
export function leaseScopeForHeartbeat(
  request: Pick<DaemonRequest, 'flags' | 'meta'>,
): LeaseScope | undefined {
  const scope = leaseScopeFromRequest(request);
  return scope.leaseId ? scope : undefined;
}

/**
 * The beat that renews a remote lease across an artifact upload, or `undefined` when there is no
 * lease to protect: only a remote daemon uploads, so only one can be waiting on a billed device, and
 * a command that names no lease has nothing to renew.
 *
 * Exported for its own coverage: `sendToDaemon` calls it once per upload, and the beat cadence is
 * far too slow for an end-to-end test to reach it at real transport speed.
 */
export function buildUploadLeaseHeartbeat(
  info: EnsuredDaemon['info'],
  settings: DaemonClientSettings,
  request: Omit<DaemonRequest, 'token'>,
): (() => Promise<unknown>) | undefined {
  if (!isRemoteDaemon(info)) return undefined;
  const leaseScope = leaseScopeForHeartbeat(request);
  if (!leaseScope) return undefined;
  const timeoutMs = resolveCommandRequestTimeoutMs(
    resolveCommandTimeoutPolicy(INTERNAL_COMMANDS.leaseHeartbeat),
    { positionals: [] },
  );
  return createLeaseRenewalBeat(leaseScope, {
    session: request.session,
    sessionIsolation: request.meta?.sessionIsolation,
    token: info.token,
    send: async (beat) =>
      await sendRequest(info, beat, settings.transportPreference, settings.paths, timeoutMs),
  });
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
