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
  isInactiveLeaseError,
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
    task: (signal) => prepareRemoteRequestArtifacts(requestWithoutAuthFlag, info, signal),
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
 * The fastest cadence a phase beats at, and the budget each beat gets until the window is known.
 *
 * Before the first beat answers, the window is unknown and the worst legal case is the registry's
 * five-second minimum: a beat that stalls must be abandoned and retried inside that window, or the
 * thing the beat exists to prevent happens while it waits. One second is a fifth of that minimum,
 * and no window-derived cadence is ever allowed below it, so it is also the loop's floor: a
 * misreported or pathologically short window cannot turn the beat into a request loop faster than
 * this.
 */
const MIN_LEASE_BEAT_INTERVAL_MS = 1_000;

/**
 * Why a beat stopped protecting the lease even though the lease may live on: this client's request
 * will never be the one that renews it.
 *
 * A beat refused for a missing or mismatched owner scope is a fact about the request, not the
 * lease, so every successor is refused identically. Surviving it would only spend the upload against
 * a lease that stops renewing — the #2946 failure with extra steps.
 */
const UNRENEWABLE_LEASE_BEAT_REASONS: ReadonlySet<unknown> = new Set([
  'LEASE_SCOPE_REQUIRED',
  'LEASE_SCOPE_MISMATCH',
]);

/**
 * Whether a beat failed for a reason every successor will repeat: the lease is gone (the shared
 * taxonomy), the daemon refused a fact baked into the beat itself, or this request can never renew
 * it. A beat's scope and ttl never change across the phase, so an `INVALID_ARGS` refusal — an
 * out-of-range ttl, an unusable lease id — is terminal without waiting out a window it can no
 * longer renew.
 *
 * `LEASE_SESSION_MISMATCH` is deliberately absent: only request admission raises it, and
 * `lease_heartbeat` is admission-exempt, so a beat can never receive it.
 */
function isTerminalLeaseBeatError(error: unknown): boolean {
  return (
    isInactiveLeaseError(error) ||
    (error instanceof AppError &&
      (UNRENEWABLE_LEASE_BEAT_REASONS.has(error.details?.reason) || error.code === 'INVALID_ARGS'))
  );
}

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
 * the phase runs untouched. The first beat is fired immediately rather than one interval in, so a
 * lease shorter than that interval is renewed before it can lapse — and a lease already gone is
 * found while the upload is still hashing. Each beat answers with the window it just renewed, and
 * the cadence becomes a third of that window.
 *
 * A beat's budget is the cadence it started on, and its successor is armed when the beat starts
 * rather than when it settles. A beat that never returns — a half-open connection, a daemon wedged
 * before it admits anything — is therefore abandoned on schedule instead of holding the schedule:
 * the lease is still beaten at window/3, and the abandoned round trip is cut off by its own budget
 * in the transport rather than by the command's 90-second heartbeat policy. An abandoned beat is
 * still listened to, because the answer it eventually gives can be a lost lease.
 *
 * A beat that fails for a reason that says nothing about this lease is reported and survived — one
 * lost request must not fail an upload that a later beat will cover. A beat that finds the lease
 * gone, or finds this client can never renew it, ends the phase with that error and aborts the
 * signal the phase runs under: the device is no longer ours (or was never reachable through this
 * request), and the only honest outcome is to say so before the bytes finish.
 */
export async function runProtectedLeaseWork<T>(
  options: Readonly<{
    /**
     * One renewal. `budgetMs` is how long this beat may take before the loop abandons it. Absent
     * when the request names no lease to renew, which is the ordinary unleased install.
     */
    heartbeat?: ((budgetMs: number) => Promise<unknown>) | undefined;
    task: (signal: AbortSignal) => Promise<T>;
  }>,
): Promise<T> {
  const { heartbeat } = options;
  if (!heartbeat) return await options.task(new AbortController().signal);

  const control = new AbortController();
  // Until a beat names the window, the loop assumes the shortest window the daemon will accept: the
  // budget of the beat that has to prove a short lease is alive cannot itself be longer than it.
  let intervalMs = MIN_LEASE_BEAT_INTERVAL_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let terminalError: unknown;
  let reportTerminal: ((error: unknown) => void) | undefined;
  const terminal = new Promise<never>((_, reject) => {
    reportTerminal = reject;
  });

  const runBeat = (): void => {
    // Armed while this beat is still outstanding: a beat that never settles is abandoned on
    // schedule rather than taking the schedule with it. The beat may re-arm it on the way out.
    const arm = (delayMs: number): void => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(runBeat, delayMs);
    };
    arm(intervalMs);
    const settle = (async () => {
      const budgetMs = intervalMs;
      try {
        const renewed = leaseWindowFromHeartbeatResponse(await heartbeat(budgetMs));
        // An answer that names no window keeps the cadence it was asked at: the loop only ever
        // slows down on evidence of how long the lease is good for, and never on the absence of it.
        if (renewed === undefined) return;
        const cadence = Math.max(MIN_LEASE_BEAT_INTERVAL_MS, Math.floor(renewed / 3));
        if (cadence === intervalMs) return;
        intervalMs = cadence;
        // The window just moved, so the next beat is due one cadence from this answer.
        arm(cadence);
      } catch (error) {
        if (isTerminalLeaseBeatError(error)) {
          terminalError = error;
          if (stopped) {
            // The phase settled first; the outcome it returned already stands, but a lease this
            // client just learned is gone is worth one diagnostic on the way out.
            emitDiagnostic({
              level: 'warn',
              phase: 'lease_lost_after_phase',
              data: { message: error instanceof Error ? error.message : String(error) },
            });
            return;
          }
          // The upload is the only thing still consuming this phase's time, and it is pointed at a
          // device this client can no longer renew. Stop it rather than finish bytes nobody owns.
          control.abort();
          reportTerminal?.(error);
          return;
        }
        emitDiagnostic({
          level: 'warn',
          phase: 'lease_heartbeat_failed',
          data: { message: error instanceof Error ? error.message : String(error) },
        });
      }
    })();
    // A beat the loop has moved on from is still listened to, and nothing awaits it: its outcome is
    // swallowed here so a beat nobody is waiting on cannot surface as an unhandled rejection.
    void settle.catch(() => undefined);
  };

  // Armed before the phase starts, not one interval in: a beat is what proves the lease the upload
  // is spending its time on is still alive.
  timer = setTimeout(runBeat, 0);
  // A beat already in flight when the phase settles can still report a lost lease; the caller reads
  // it from `terminalError`, so nothing may be left racing on this rejection by then.
  void terminal.catch(() => undefined);
  const phase = await captureOutcome(
    // The async boundary also turns a synchronous throw from the phase into a rejection, so the
    // timer below is always cleared.
    (async () => await Promise.race([options.task(control.signal), terminal]))(),
  );
  stopped = true;
  if (timer) clearTimeout(timer);
  // No outstanding beat is awaited here: a beat on a half-open connection would hold a finished
  // upload behind its own budget for no decision the phase still has to make.
  // A beat that ended the protection outranks a phase that settled meanwhile, from either side: the
  // device is no longer ours, and the lease error is the reason the phase was not worth finishing.
  if (terminalError !== undefined) throw terminalError;
  if (!phase.ok) throw phase.error;
  return phase.value;
}

/**
 * The inactivity window a beat just renewed, read from the lease its response carries.
 *
 * `heartbeatLease` answers with the lease, whose `expiresAt - heartbeatAt` is exactly the window it
 * extended — the same pair `leaseOwnTtlMs` renews on. Anything unrecognizable leaves the caller on
 * the fallback cadence rather than guessing one.
 */
function leaseWindowFromHeartbeatResponse(response: unknown): number | undefined {
  const lease = (
    response as Readonly<{ data?: Readonly<{ lease?: Readonly<Record<string, unknown>> }> }>
  )?.data?.lease;
  const expiresAt = lease?.expiresAt;
  const heartbeatAt = lease?.heartbeatAt;
  if (typeof expiresAt !== 'number' || typeof heartbeatAt !== 'number') return undefined;
  return expiresAt > heartbeatAt ? expiresAt - heartbeatAt : undefined;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function captureOutcome<T>(promise: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * The beat that keeps a remote lease alive across a long client-side phase.
 *
 * `send` is the caller's transport and `budgetMs` is how long this beat may take: the beat's answer
 * only matters before the next one is due, so a stalled round trip is cut off at the cadence rather
 * than at the command's own 90-second heartbeat policy. A beat is only ever sent to a remote daemon,
 * where a transport timeout performs no local cleanup.
 */
export function createLeaseRenewalBeat(
  leaseScope: LeaseScope,
  context: Readonly<{
    session: string;
    sessionIsolation?: NonNullable<DaemonRequest['meta']>['sessionIsolation'];
    token: string;
    send: (request: DaemonRequest, budgetMs: number) => Promise<unknown>;
  }>,
): (budgetMs: number) => Promise<unknown> {
  return async (budgetMs) =>
    await context.send(
      buildLeaseHeartbeatRequest(leaseScope, {
        session: context.session,
        sessionIsolation: context.sessionIsolation,
        requestId: createRequestId(),
        token: context.token,
      }),
      budgetMs,
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
 * Each beat's transport timeout is its budget, capped by the command's heartbeat policy: the answer
 * is worthless once the next beat is due, so a stalled round trip is cut off and destroyed at the
 * cadence instead of holding a socket for 90 seconds. `sendToDaemon` wires this once per upload.
 */
export function buildUploadLeaseHeartbeat(
  info: EnsuredDaemon['info'],
  settings: DaemonClientSettings,
  request: Omit<DaemonRequest, 'token'>,
): ((budgetMs: number) => Promise<unknown>) | undefined {
  if (!isRemoteDaemon(info)) return undefined;
  const leaseScope = leaseScopeForHeartbeat(request);
  if (!leaseScope) return undefined;
  const policyTimeoutMs = resolveCommandRequestTimeoutMs(
    resolveCommandTimeoutPolicy(INTERNAL_COMMANDS.leaseHeartbeat),
    { positionals: [] },
  );
  return createLeaseRenewalBeat(leaseScope, {
    session: request.session,
    sessionIsolation: request.meta?.sessionIsolation,
    token: info.token,
    send: async (beat, budgetMs) =>
      await sendRequest(
        info,
        beat,
        settings.transportPreference,
        settings.paths,
        // The beat's own budget governs; the command's heartbeat policy only ever caps it, and an
        // unbounded policy leaves the budget standing on its own.
        policyTimeoutMs === undefined ? budgetMs : Math.min(policyTimeoutMs, budgetMs),
      ),
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
