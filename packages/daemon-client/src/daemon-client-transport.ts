import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { RequestProgressSink } from '@agent-device/contracts/progress';
import net from 'node:net';
import { AppError } from '@agent-device/kernel/errors';
import { loadNodeHttpRequester, readNodeHttpResponseBody } from '@agent-device/host-kit/transport';
import {
  assertScriptArtifactsCapability,
  readDaemonCapabilities,
  type DaemonPaths,
  type DaemonTransportPreference,
} from '@agent-device/daemon-contracts/daemon-resolution';
import {
  readDaemonHttpProgressResponse,
  readDaemonSocketProgressResponse,
  shouldReadDaemonProgressStream,
} from './daemon-client-progress.ts';
import {
  buildDaemonHttpAuthHeaders,
  buildDaemonHttpUrl,
  DAEMON_HTTP_INSTANCE_HEADER,
  DAEMON_HTTP_INSTANCE_MISMATCH_HEADER,
  DAEMON_INSTANCE_REASONS,
  DAEMON_HTTP_UPSTREAM_INSTANCE_HEADER,
  DAEMON_RPC_PROTOCOL_VERSION,
  type DaemonHealthPayload,
} from '@agent-device/contracts/daemon-http';
import { DAEMON_TRANSPORT_REASONS } from './daemon-client-transport-reasons.ts';
import {
  buildHttpRpcPayload,
  handleDaemonHttpResponseBody,
  incompatibleRemoteProtocolError,
  refuseOversizedDaemonRequest,
} from './daemon-client-rpc.ts';
import {
  abortedRequestError,
  handleRequestTimeout,
  handleTransportError,
  refuseAbortedRequest,
  requestTimeoutError,
} from './daemon-client-timeout.ts';
import { isRemoteDaemon, type DaemonInfo } from './daemon-client-metadata.ts';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type {
  DaemonProbeVerdict,
  LoopbackConnectDenial,
  LoopbackTransport,
} from './daemon-client-loopback-probe.ts';

type ResolvedDaemonTransport = LoopbackTransport;
export type SendRequestOptions = {
  /** The host whose working directory and environment this request's client-side work reads. */
  host: HostEnvironment;
  onProgress?: RequestProgressSink;
  /**
   * The caller's per-request cancellation (#3178). Aborted at or before a send attempt, nothing
   * leaves on that attempt; aborted in flight, the attempt's own connection is destroyed — which is
   * what makes the daemon mark the request canceled — and the promise rejects with the typed
   * canceled-request error. An abort is never a timeout: it never reaches `handleRequestTimeout`.
   */
  signal?: AbortSignal;
  /**
   * What a timed-out request may do to the daemon. `retire-unresponsive`, the default, lets the
   * liveness probe retire a daemon that answers nothing; `none` leaves every daemon alone, which is
   * how an attach client and the quiesce request itself time out.
   */
  timeoutRecovery?: 'retire-unresponsive' | 'none';
  /** Re-probes a daemon whose `/health` answer was cached, before an unsent request is resent. */
  remoteHealthGate?: (
    budgetMs: number | undefined,
    signal: AbortSignal | undefined,
  ) => Promise<void>;
};

const LOCAL_DAEMON_HEALTHCHECK_TIMEOUT_MS = 500;
const REMOTE_DAEMON_HEALTHCHECK_TIMEOUT_MS = 3000;

export function isDaemonTransportUnavailableError(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === 'COMMAND_FAILED' &&
    error.details?.reason === DAEMON_TRANSPORT_REASONS.endpointUnavailable.reason
  );
}

function daemonEndpointUnavailableError(transport: ResolvedDaemonTransport): AppError {
  return new AppError(
    'COMMAND_FAILED',
    transport === 'http'
      ? 'Daemon HTTP endpoint is unavailable'
      : 'Daemon socket endpoint is unavailable',
    { reason: DAEMON_TRANSPORT_REASONS.endpointUnavailable.reason, transport },
  );
}

export type RemoteDaemonHealth = {
  reachable: boolean;
  statusCode?: number;
  service?: string;
  version?: string;
  rpcProtocolVersion?: number;
  instanceId?: string;
  hostArch?: string;
  capabilities?: DaemonInfo['capabilities'];
  /** The daemon behind a proxy, as the proxy's health reported it. */
  upstream?: RemoteDaemonHealthLink;
  /** The probe ran out of its time budget before an answer, rather than failing outright. */
  timedOut?: true;
};

type RemoteDaemonHealthLink = Pick<
  RemoteDaemonHealth,
  'service' | 'version' | 'rpcProtocolVersion' | 'instanceId' | 'hostArch' | 'capabilities'
>;

export async function probeDaemonReachability(
  info: DaemonInfo,
  preference: DaemonTransportPreference,
  probeTimeoutMs?: number,
): Promise<DaemonProbeVerdict> {
  const deadline = Date.now() + (probeTimeoutMs ?? Number.POSITIVE_INFINITY);
  const transport = chooseTransport(info, preference);
  const fallback = chooseAutoFallbackTransport(info, preference, transport);
  const firstBudget = (deadline - Date.now()) / (fallback ? 2 : 1);
  const first = await probeTransportEndpoint(info, transport, firstBudget);
  if (first.reachable) return { reachable: Date.now() < deadline };
  if (!fallback) return first;
  const second = await probeTransportEndpoint(info, fallback, deadline - Date.now());
  if (second.reachable) return answeredWithinDeadline(deadline, first.denial);
  // One refused leg is enough to withhold a death verdict: the client cannot read the other leg's
  // silence as proof while the host has shown it refuses this daemon's endpoints.
  return { reachable: false, denial: first.denial ?? second.denial };
}

/**
 * A leg that answered after the deadline is not a reachable daemon, but a refusal the other leg
 * reported is still evidence this client holds. It travels with the verdict, so a late answer
 * cannot turn a refused endpoint back into a dead daemon.
 */
function answeredWithinDeadline(
  deadline: number,
  denial?: LoopbackConnectDenial,
): DaemonProbeVerdict {
  return Date.now() < deadline ? { reachable: true } : { reachable: false, denial };
}

async function probeTransportEndpoint(
  info: DaemonInfo,
  transport: ResolvedDaemonTransport,
  timeoutMs: number,
): Promise<DaemonProbeVerdict> {
  // Loaded here, never at module scope: no client entry surface pays for a verdict it only reads on a
  // probe (`scripts/__tests__/eager-closure-budgets.ts`).
  const { probeHttpEndpoint, probeLoopbackPort } =
    await import('./daemon-client-loopback-probe.ts');
  if (transport !== 'http') return await probeLoopbackPort(info.port, 'socket', timeoutMs);
  const endpoint = daemonHealthEndpoint(info);
  if (!endpoint) return { reachable: false };
  return await probeHttpEndpoint({
    endpoint,
    headers: info.baseUrl ? buildDaemonHttpAuthHeaders(info.token) : {},
    timeoutMs: Math.min(
      info.baseUrl ? REMOTE_DAEMON_HEALTHCHECK_TIMEOUT_MS : LOCAL_DAEMON_HEALTHCHECK_TIMEOUT_MS,
      timeoutMs,
    ),
  });
}

export async function readRemoteDaemonHealth(
  info: DaemonInfo,
  probeTimeoutMs?: number,
  callerSignal?: AbortSignal,
): Promise<RemoteDaemonHealth> {
  const health = await readDaemonHttpHealth(info, probeTimeoutMs, callerSignal);
  if (!info.baseUrl || !health.reachable) return health;
  // Every link a command RPC crosses has to speak the client's protocol: a proxy that reports a
  // skewed daemon behind it fails here, before the RPC, exactly like a skewed proxy does.
  const incompatible = [health, health.upstream].find(
    (link): link is RemoteDaemonHealthLink & { rpcProtocolVersion: number } =>
      typeof link?.rpcProtocolVersion === 'number' &&
      link.rpcProtocolVersion !== DAEMON_RPC_PROTOCOL_VERSION,
  );
  if (!incompatible) return health;
  const proxy = incompatible === health.upstream ? { service: health.service } : undefined;
  throw incompatibleRemoteProtocolError(info.baseUrl, incompatible, proxy);
}

function daemonHealthEndpoint(info: DaemonInfo): string | null {
  return daemonHttpEndpoint(info, 'health');
}

function daemonHttpEndpoint(info: DaemonInfo, route: 'health' | 'rpc'): string | null {
  return info.baseUrl
    ? buildDaemonHttpUrl(info.baseUrl, route)
    : info.httpPort
      ? `http://127.0.0.1:${info.httpPort}/${route}`
      : null;
}

async function readDaemonHttpHealth(
  info: DaemonInfo,
  probeTimeoutMs?: number,
  callerSignal?: AbortSignal,
): Promise<RemoteDaemonHealth> {
  const endpoint = daemonHealthEndpoint(info);
  if (!endpoint) return { reachable: false };
  const url = new URL(endpoint);
  const timeoutMs = Math.min(
    info.baseUrl ? REMOTE_DAEMON_HEALTHCHECK_TIMEOUT_MS : LOCAL_DAEMON_HEALTHCHECK_TIMEOUT_MS,
    probeTimeoutMs ?? Number.POSITIVE_INFINITY,
  );
  if (timeoutMs <= 0) return { reachable: false, timedOut: true };
  const deadline = performance.now() + timeoutMs;
  const timeoutSignal = AbortSignal.timeout(Math.ceil(timeoutMs));
  const signal = callerSignal ? AbortSignal.any([timeoutSignal, callerSignal]) : timeoutSignal;
  const transport = await Promise.race([
    loadNodeHttpRequester(url.protocol),
    new Promise<null>((resolve) => {
      signal.addEventListener('abort', () => resolve(null), { once: true });
    }),
  ]);
  const unreachable = (): RemoteDaemonHealth => unreachableDaemonHealth(timeoutSignal, deadline);
  if (!transport || healthProbeExpired(signal, deadline)) return unreachable();
  return await new Promise((resolve) => {
    const headers = info.baseUrl ? buildDaemonHttpAuthHeaders(info.token) : {};
    const req = transport.request(
      {
        protocol: url.protocol,
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'GET',
        timeout: timeoutMs,
        signal,
        headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          const statusCode = res.statusCode ?? 500;
          resolve(
            healthProbeExpired(timeoutSignal, deadline)
              ? { reachable: false, timedOut: true }
              : { reachable: statusCode < 500, statusCode, ...readHealthPayload(body) },
          );
        });
        res.on('error', () => resolve(unreachable()));
        res.on('aborted', () => resolve(unreachable()));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ reachable: false, timedOut: true });
    });
    req.on('error', () => {
      resolve(unreachable());
    });
    req.end();
  });
}

function unreachableDaemonHealth(timeoutSignal: AbortSignal, deadline: number): RemoteDaemonHealth {
  return healthProbeExpired(timeoutSignal, deadline)
    ? { reachable: false, timedOut: true }
    : { reachable: false };
}

function healthProbeExpired(signal: AbortSignal, deadline: number): boolean {
  return signal.aborted || performance.now() >= deadline;
}

function readHealthPayload(body: string): Omit<RemoteDaemonHealth, 'reachable' | 'statusCode'> {
  try {
    const parsed = JSON.parse(body) as { upstream?: unknown };
    const upstream =
      parsed.upstream && typeof parsed.upstream === 'object'
        ? readHealthLink(parsed.upstream as Record<string, unknown>)
        : undefined;
    return {
      ...readHealthLink(parsed as Record<string, unknown>),
      ...(upstream ? { upstream } : {}),
    };
  } catch {
    return {};
  }
}

function readHealthLink(parsed: Record<string, unknown>): RemoteDaemonHealthLink {
  return {
    service: isHealthService(parsed.service) ? parsed.service : undefined,
    version: readHealthVersion(parsed.version),
    rpcProtocolVersion:
      typeof parsed.rpcProtocolVersion === 'number' ? parsed.rpcProtocolVersion : undefined,
    ...(typeof parsed.instanceId === 'string' ? { instanceId: parsed.instanceId } : {}),
    ...(typeof parsed.hostArch === 'string' ? { hostArch: parsed.hostArch } : {}),
    ...(parsed.capabilities === undefined
      ? {}
      : { capabilities: readDaemonCapabilities(parsed.capabilities) }),
  };
}

// The remote picks what /health says and agents read the refusal built from it, so only a service
// the contract names and a version-shaped string are kept; anything else reads as absent.
const HEALTH_SERVICES: Readonly<Record<DaemonHealthPayload['service'], true>> = {
  'agent-device-daemon': true,
  'agent-device-proxy': true,
};
const HEALTH_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HEALTH_VERSION_MAX_LENGTH = 64;

function isHealthService(value: unknown): value is DaemonHealthPayload['service'] {
  return typeof value === 'string' && Object.hasOwn(HEALTH_SERVICES, value);
}

function readHealthVersion(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length <= HEALTH_VERSION_MAX_LENGTH &&
    HEALTH_VERSION.test(value)
    ? value
    : undefined;
}

export async function sendRequest(
  info: DaemonInfo,
  req: DaemonWireRequest,
  preference: DaemonTransportPreference,
  statePaths: DaemonPaths,
  timeoutMs: number | undefined,
  options: SendRequestOptions,
): Promise<DaemonResponse> {
  try {
    return await sendRequestWithFallback(info, req, preference, statePaths, timeoutMs, options);
  } catch (error) {
    const failure = await recoverFromTimeout(error, info, req, statePaths, options);
    const transport = classifyTransportFailure(failure);
    if (!transport) throw failure;
    // Loaded only on this path: the registry lookup costs nothing on a healthy request.
    const { discloseRequestFailure } = await import('./daemon-client-dispatch-disclosure.ts');
    throw discloseRequestFailure(transport.failure, req, transport.sent);
  }
}

async function recoverFromTimeout(
  error: unknown,
  info: DaemonInfo,
  req: DaemonWireRequest,
  statePaths: DaemonPaths,
  options: SendRequestOptions,
): Promise<unknown> {
  if (
    !(error instanceof AppError) ||
    error.details?.reason !== DAEMON_TRANSPORT_REASONS.timeout.reason
  ) {
    return error;
  }
  const expiredBudget = error.details.timeoutMs;
  if (typeof expiredBudget !== 'number') return error;
  return await handleRequestTimeout({
    info,
    statePaths,
    remote: isRemoteDaemon(info),
    retireUnresponsive: options.timeoutRecovery !== 'none',
    timeoutMs: expiredBudget,
    requestId: req.meta?.requestId,
    command: req.command,
    platform: req.flags?.platform,
    session: req.session,
    action: req.positionals?.[0],
    requestSent: error.details.daemonRequestSent !== false,
    responseStarted: error.details.remoteResponseStarted === true,
    readRemoteHealth: async (budgetMs) => {
      const health = await readDaemonHttpHealth(info, budgetMs, options.signal);
      // A caller abort proves nothing about the daemon; any other miss or changed instance does.
      const replaced =
        health.instanceId !== info.remoteInstanceId ||
        health.upstream?.instanceId !== info.remoteUpstreamInstanceId;
      if (!options.signal?.aborted && (!health.reachable || replaced)) {
        await invalidateRemoteDaemonHealth(info, statePaths.baseDir);
      }
      return health;
    },
  });
}

/**
 * One of the transport's own failures, with whether it happened after the request left this
 * process (the daemon may have run it). A lost connection or a timeout records
 * `daemonRequestSent`; a reply that could not be read or parsed was always sent.
 *
 * A `daemon-connect-denied` is usually a pre-send finding and is left alone. Only the one a timeout
 * produced carries `daemonRequestSent`, and that one has to reach the disclosure seam too: the request
 * was written before the host refused the probe, so the caller must still be told it may have run.
 */
function classifyTransportFailure(
  error: unknown,
): { failure: AppError; sent: boolean } | undefined {
  if (!(error instanceof AppError)) return undefined;
  switch (error.details?.reason) {
    case DAEMON_TRANSPORT_REASONS.failure.reason:
    case DAEMON_TRANSPORT_REASONS.timeout.reason:
      return { failure: error, sent: error.details.daemonRequestSent !== false };
    case DAEMON_TRANSPORT_REASONS.replyUnreadable.reason:
    case DAEMON_TRANSPORT_REASONS.replyInvalid.reason:
      return { failure: error, sent: true };
    default:
      // A refusal this module did not produce, from the timeout route, states for itself that the
      // request left this process. It gets the same disclosure: the daemon may have run it.
      return error.details?.daemonRequestSent === true ? { failure: error, sent: true } : undefined;
  }
}

async function sendRequestWithFallback(
  info: DaemonInfo,
  req: DaemonWireRequest,
  preference: DaemonTransportPreference,
  statePaths: DaemonPaths,
  timeoutMs: number | undefined,
  options: SendRequestOptions,
): Promise<DaemonResponse> {
  const transport = chooseTransport(info, preference);
  const deadline = typeof timeoutMs === 'number' ? performance.now() + timeoutMs : undefined;
  // A canceled caller must not open a connection just to lose it, and a fallback or instance retry
  // that begins after the abort must not send either — every attempt starts behind this check.
  refuseAbortedRequest(options.signal, req.meta?.requestId);
  try {
    return await sendRequestWithTransport(info, req, statePaths, timeoutMs, transport, options);
  } catch (error) {
    if (
      info.baseUrl &&
      isRemoteInstanceMismatch(error) &&
      error instanceof AppError &&
      PROVEN_STALE.has(error)
    ) {
      return await retryAfterRemoteInstanceMismatch(
        info,
        req,
        statePaths,
        timeoutMs,
        deadline,
        transport,
        options,
      );
    }
    if (dropsCachedRemoteHealth(error)) {
      await invalidateRemoteDaemonHealth(info, statePaths.baseDir);
    }
    if (info.baseUrl && options.remoteHealthGate && isProvenUnsentFailure(error)) {
      return await resendAfterRemoteHealthGate(
        options.remoteHealthGate,
        info,
        req,
        statePaths,
        timeoutMs,
        deadline,
        transport,
        options,
      );
    }
    const fallback = chooseAutoFallbackTransport(info, preference, transport);
    if (!fallback || !isSafeAutoTransportFallbackError(error, transport)) throw error;
    return await sendRequestWithTransport(info, req, statePaths, timeoutMs, fallback, options);
  }
}

async function retryAfterRemoteInstanceMismatch(
  info: DaemonInfo,
  req: DaemonWireRequest,
  statePaths: DaemonPaths,
  timeoutMs: number | undefined,
  deadline: number | undefined,
  transport: ResolvedDaemonTransport,
  options: SendRequestOptions,
): Promise<DaemonResponse> {
  await invalidateRemoteDaemonHealth(info, statePaths.baseDir);
  const probeTimeoutMs = remainingRemoteRequestTimeoutMs(req, timeoutMs, deadline);
  const health = await readRemoteDaemonHealth(info, probeTimeoutMs, options.signal);
  refuseAbortedRequest(options.signal, req.meta?.requestId);
  const remainingMs = remainingRemoteRequestTimeoutMs(
    req,
    timeoutMs,
    deadline,
    health.timedOut ? probeTimeoutMs : undefined,
  );
  if (!health.reachable) {
    const { remoteDaemonUnavailableError } = await import('./daemon-lifecycle-errors.ts');
    throw remoteDaemonUnavailableError({ daemonBaseUrl: info.baseUrl, attempts: 1 });
  }
  applyRemoteDaemonHealth(info, health);
  (await loadRemoteHealthCache()).cacheRemoteDaemonHealth(info, health, statePaths.baseDir);
  return await resendAfterFreshRemoteHealth(info, req, statePaths, remainingMs, transport, options);
}

/**
 * Only a send whose connection never opened proves nothing reached the daemon. It gets the gate the
 * cache skipped, then one resend, both within what is left of the command's budget.
 */
async function resendAfterRemoteHealthGate(
  gate: (budgetMs: number | undefined) => Promise<void>,
  info: DaemonInfo,
  req: DaemonWireRequest,
  statePaths: DaemonPaths,
  timeoutMs: number | undefined,
  deadline: number | undefined,
  transport: ResolvedDaemonTransport,
  options: SendRequestOptions,
): Promise<DaemonResponse> {
  const requestId = req.meta?.requestId;
  const gateBudgetMs = remainingRemoteRequestTimeoutMs(req, timeoutMs, deadline);
  try {
    await gate(gateBudgetMs, options.signal);
  } catch (error) {
    refuseAbortedRequest(options.signal, requestId);
    throw error;
  }
  refuseAbortedRequest(options.signal, requestId);
  const resendOptions = { ...options, remoteHealthGate: undefined };
  return await resendAfterFreshRemoteHealth(
    info,
    req,
    statePaths,
    remainingRemoteRequestTimeoutMs(req, timeoutMs, deadline),
    transport,
    resendOptions,
  );
}

async function resendAfterFreshRemoteHealth(
  info: DaemonInfo,
  req: DaemonWireRequest,
  statePaths: DaemonPaths,
  timeoutMs: number | undefined,
  transport: ResolvedDaemonTransport,
  options: SendRequestOptions,
): Promise<DaemonResponse> {
  // A replacement daemon must still deliver the script that a remote recording asks for.
  if (req.meta?.scriptPublicationId) assertScriptArtifactsCapability(info.capabilities);
  try {
    return await sendRequestWithTransport(info, req, statePaths, timeoutMs, transport, options);
  } catch (error) {
    if (dropsCachedRemoteHealth(error)) {
      await invalidateRemoteDaemonHealth(info, statePaths.baseDir);
    }
    throw error;
  }
}

/** Points `info` at the daemon a `/health` answer describes: its instances and capabilities. */
export function applyRemoteDaemonHealth(info: DaemonInfo, health: RemoteDaemonHealth): void {
  info.remoteInstanceId = health.instanceId;
  info.remoteUpstreamInstanceId = health.upstream?.instanceId;
  info.capabilities = (health.upstream ?? health).capabilities;
}

// Evidence only this module records; a daemon error can carry the same reason and details.
/** Failures and timeouts raised here before the HTTP connection opened. */
const PROVEN_UNSENT = new WeakSet<AppError>();
/** Refusals raised here from a 409 with the instance-mismatch header. */
const PROVEN_STALE = new WeakSet<AppError>();

function isProvenUnsentFailure(error: unknown): boolean {
  return (
    error instanceof AppError &&
    PROVEN_UNSENT.has(error) &&
    error.details?.reason === DAEMON_TRANSPORT_REASONS.failure.reason
  );
}

function remainingRemoteRequestTimeoutMs(
  req: DaemonWireRequest,
  timeoutMs: number | undefined,
  deadline: number | undefined,
  timedOutProbeMs?: number,
): number | undefined {
  if (deadline === undefined || timeoutMs === undefined) return undefined;
  const remainingMs = deadline - performance.now();
  // A probe capped by the request can expire before the monotonic clock catches up to its timer.
  if (
    remainingMs > 0 &&
    (timedOutProbeMs === undefined || timedOutProbeMs > REMOTE_DAEMON_HEALTHCHECK_TIMEOUT_MS)
  )
    return remainingMs;
  throw requestTimeoutError(timeoutMs, req.meta?.requestId, false);
}

function isRemoteInstanceMismatch(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.details?.reason === DAEMON_INSTANCE_REASONS.instanceMismatch.reason
  );
}

// A sent request's timeout is left to the timeout route, which drops the cache only when its probe
// shows the daemon gone or replaced; an unsent one, or a proven stale instance, drops it here.
function dropsCachedRemoteHealth(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  if (PROVEN_UNSENT.has(error) || PROVEN_STALE.has(error)) return true;
  return (
    error.details?.reason === DAEMON_TRANSPORT_REASONS.failure.reason ||
    error.details?.reason === DAEMON_TRANSPORT_REASONS.replyUnreadable.reason
  );
}

async function sendRequestWithTransport(
  info: DaemonInfo,
  req: DaemonWireRequest,
  statePaths: DaemonPaths,
  timeoutMs: number | undefined,
  transport: ResolvedDaemonTransport,
  options: SendRequestOptions,
): Promise<DaemonResponse> {
  return transport === 'http'
    ? await sendHttpRequest(info, req, statePaths, timeoutMs, options)
    : await sendSocketRequest(info, req, timeoutMs, options);
}

function chooseTransport(
  info: DaemonInfo,
  preference: DaemonTransportPreference,
): ResolvedDaemonTransport {
  if (info.baseUrl) {
    // Defensive guard: resolveClientSettings rejects this earlier for normal CLI flow.
    if (preference === 'socket') {
      throw new AppError('COMMAND_FAILED', 'Remote daemon endpoint only supports HTTP transport', {
        daemonBaseUrl: info.baseUrl,
      });
    }
    return 'http';
  }
  if (preference === 'http' || preference === 'socket') {
    return requireDaemonTransport(info, preference);
  }
  const autoOrder: ResolvedDaemonTransport[] =
    info.transport === 'socket' || info.transport === 'dual'
      ? ['socket', 'http']
      : ['http', 'socket'];
  const available = autoOrder.find((transport) => hasDaemonTransport(info, transport));
  if (available) return available;
  throw new AppError('COMMAND_FAILED', 'Daemon metadata has no reachable transport');
}

function hasDaemonTransport(info: DaemonInfo, transport: ResolvedDaemonTransport): boolean {
  return transport === 'http' ? Boolean(info.httpPort) : Boolean(info.port);
}

function chooseAutoFallbackTransport(
  info: DaemonInfo,
  preference: DaemonTransportPreference,
  attempted: ResolvedDaemonTransport,
): ResolvedDaemonTransport | null {
  if (preference !== 'auto' || info.baseUrl) return null;
  const fallback = attempted === 'socket' ? 'http' : 'socket';
  return hasDaemonTransport(info, fallback) ? fallback : null;
}

function isSafeAutoTransportFallbackError(
  error: unknown,
  attempted: ResolvedDaemonTransport,
): boolean {
  return (
    attempted === 'socket' &&
    error instanceof AppError &&
    error.details?.reason === DAEMON_TRANSPORT_REASONS.failure.reason &&
    error.details.daemonRequestSent === false
  );
}

function requireDaemonTransport(
  info: DaemonInfo,
  transport: ResolvedDaemonTransport,
): ResolvedDaemonTransport {
  if (hasDaemonTransport(info, transport)) return transport;
  throw daemonEndpointUnavailableError(transport);
}

async function sendSocketRequest(
  info: DaemonInfo,
  req: DaemonWireRequest,
  timeoutMs: number | undefined,
  options: SendRequestOptions,
): Promise<DaemonResponse> {
  const port = info.port;
  if (!port) throw daemonEndpointUnavailableError('socket');
  const callerSignal = options.signal;
  refuseAbortedRequest(callerSignal, req.meta?.requestId);
  // The daemon measures the request without its framing newline.
  const request = JSON.stringify(req);
  refuseOversizedDaemonRequest(request, req.meta?.requestId);
  const requestLine = `${request}\n`;
  return new Promise((resolve, reject) => {
    let requestWritten = false;
    let settled = false;
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      // An abort that landed while the connection was still opening must not write the request.
      if (callerSignal?.aborted) {
        settled = true;
        rejectAborted(callerSignal);
        return;
      }
      requestWritten = true;
      socket.write(requestLine);
    });
    const timeoutHandle =
      typeof timeoutMs === 'number'
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            detachCallerAbort();
            reject(requestTimeoutError(timeoutMs, req.meta?.requestId, requestWritten));
            socket.destroy();
          }, timeoutMs)
        : undefined;
    // Destroying the connection is what makes the daemon mark the request canceled. The timeout
    // timer is cleared here because an abort is never a timeout: nothing may run the timeout's
    // runner sweep or daemon reset after the caller canceled.
    const rejectAborted = (signal: AbortSignal): void => {
      detachCallerAbort();
      if (timeoutHandle) clearTimeout(timeoutHandle);
      socket.destroy();
      reject(abortedRequestError(signal, requestWritten ? 'unknown' : 'no', req.meta?.requestId));
    };
    const onCallerAbort = (): void => {
      if (settled) return;
      settled = true;
      rejectAborted(callerSignal!);
    };
    const detachCallerAbort = (): void => {
      if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
    };
    if (callerSignal) {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }

    readDaemonSocketProgressResponse(socket, {
      req,
      onProgress: options.onProgress,
      isSettled: () => settled,
      clearTimeout: () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      },
      resolve: (response) => {
        settled = true;
        detachCallerAbort();
        resolve(response);
      },
      reject: (error) => {
        settled = true;
        detachCallerAbort();
        reject(error);
      },
    });

    socket.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      detachCallerAbort();
      reject(handleTransportError(err, req.meta?.requestId, false, requestWritten));
    });
  });
}

function buildRemoteInstancePreconditionHeaders(info: DaemonInfo): Record<string, string> {
  return {
    ...(info.remoteInstanceId ? { [DAEMON_HTTP_INSTANCE_HEADER]: info.remoteInstanceId } : {}),
    ...(info.remoteUpstreamInstanceId
      ? { [DAEMON_HTTP_UPSTREAM_INSTANCE_HEADER]: info.remoteUpstreamInstanceId }
      : {}),
  };
}

function isRemoteInstanceMismatchResponse(
  statusCode: number | undefined,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  return statusCode === 409 && headers[DAEMON_HTTP_INSTANCE_MISMATCH_HEADER] === 'true';
}

async function sendHttpRequest(
  info: DaemonInfo,
  req: DaemonWireRequest,
  statePaths: DaemonPaths,
  timeoutMs: number | undefined,
  options: SendRequestOptions,
): Promise<DaemonResponse> {
  const rpcEndpoint = daemonHttpEndpoint(info, 'rpc');
  if (!rpcEndpoint) throw daemonEndpointUnavailableError('http');
  const rpcUrl = new URL(rpcEndpoint);
  const rpcPayload = JSON.stringify(buildHttpRpcPayload(req, { includeTokenParam: !info.baseUrl }));
  refuseOversizedDaemonRequest(rpcPayload, req.meta?.requestId);
  const headers: Record<string, string | number> = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(rpcPayload),
  };
  if (info.baseUrl) {
    Object.assign(headers, buildDaemonHttpAuthHeaders(info.token));
    Object.assign(headers, buildRemoteInstancePreconditionHeaders(info));
  }
  const transport = await loadNodeHttpRequester(rpcUrl.protocol);
  const callerSignal = options.signal;
  refuseAbortedRequest(callerSignal, req.meta?.requestId);
  // A remote 5xx means the daemon or a hop before it failed, so the next command probes again.
  let serverError = false;
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      // Set once a connection opened; a reused pooled socket is already open.
      let connected = false;
      // Set when the request was handed to the OS (`finish`), never for a connection that failed first.
      let requestSent = false;
      // Set when a 2xx progress stream opened on `/rpc`, proving the remote URL and auth token.
      let responseStarted = false;
      const detachCallerAbort = (): void => {
        if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
      };
      const resolveOnce = (response: DaemonResponse | PromiseLike<DaemonResponse>): void => {
        if (settled) return;
        settled = true;
        detachCallerAbort();
        resolve(response);
      };
      const rejectOnce = (error: unknown): void => {
        if (settled) return;
        settled = true;
        detachCallerAbort();
        reject(error);
      };
      const handleBody = (body: string): void => {
        handleDaemonHttpResponseBody(body, {
          info,
          req,
          stateDir: statePaths.baseDir,
          host: options.host,
          resolve: resolveOnce,
          reject: rejectOnce,
        });
      };
      const request = transport.request(
        {
          protocol: rpcUrl.protocol,
          host: rpcUrl.hostname,
          port: rpcUrl.port,
          method: 'POST',
          path: rpcUrl.pathname + rpcUrl.search,
          headers,
        },
        (res) => {
          if (info.baseUrl && (res.statusCode ?? 0) >= 500) serverError = true;
          if (isRemoteInstanceMismatchResponse(res.statusCode, res.headers ?? {})) {
            res.resume();
            if (timeoutHandle) clearTimeout(timeoutHandle);
            const stale = new AppError('COMMAND_FAILED', 'Remote daemon instance changed', {
              reason: DAEMON_INSTANCE_REASONS.instanceMismatch.reason,
              daemonBaseUrl: info.baseUrl,
            });
            PROVEN_STALE.add(stale);
            rejectOnce(stale);
            return;
          }
          if (shouldReadDaemonProgressStream(req, res.headers?.['content-type'])) {
            if (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300) {
              responseStarted = true;
            }
            readDaemonHttpProgressResponse(res, {
              req,
              onProgress: options.onProgress,
              reject: rejectOnce,
              clearTimeout: () => {
                if (timeoutHandle) clearTimeout(timeoutHandle);
              },
              handleResponseBody: handleBody,
            });
            return;
          }
          const responseBody = readNodeHttpResponseBody(res).catch((error: unknown) => {
            throw new AppError(
              'COMMAND_FAILED',
              'Failed to read daemon response',
              {
                requestId: req.meta?.requestId,
                reason: DAEMON_TRANSPORT_REASONS.replyUnreadable.reason,
              },
              error instanceof Error ? error : undefined,
            );
          });
          void responseBody
            .then((body) => {
              if (timeoutHandle) clearTimeout(timeoutHandle);
              handleBody(body);
            })
            .catch((error: unknown) => {
              if (timeoutHandle) clearTimeout(timeoutHandle);
              rejectOnce(error);
            });
        },
      );

      const remote = isRemoteDaemon(info);
      const timeoutHandle =
        typeof timeoutMs === 'number'
          ? setTimeout(() => {
              const expired = requestTimeoutError(
                timeoutMs,
                req.meta?.requestId,
                requestSent,
                responseStarted,
              );
              if (!connected) PROVEN_UNSENT.add(expired);
              rejectOnce(expired);
              request.destroy();
            }, timeoutMs)
          : undefined;

      // Destroying the request closes this one connection, which is what makes the daemon mark the
      // request canceled. The timeout timer is cleared because an abort is never a timeout: nothing
      // may run the timeout's runner sweep or daemon reset after the caller canceled. The settle goes
      // first so the `error` the destroy surfaces arrives after `settled` and cannot rewrite the
      // typed cancellation into a transport failure.
      const onCallerAbort = (): void => {
        if (settled) return;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        rejectOnce(
          abortedRequestError(callerSignal!, requestSent ? 'unknown' : 'no', req.meta?.requestId),
        );
        request.destroy();
      };
      if (callerSignal) {
        callerSignal.addEventListener('abort', onCallerAbort, { once: true });
      }

      request.on('error', (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        // `request.destroy()` surfaces an `error` after an intentional abort or timeout has already
        // settled this promise. Returning before `handleTransportError` keeps that expected teardown
        // from emitting a `daemon_request_socket_error` diagnostic; a genuine transport error still
        // arrives before the settle and rejects.
        if (settled) return;
        const failure = handleTransportError(err, req.meta?.requestId, remote, requestSent);
        if (!connected) PROVEN_UNSENT.add(failure);
        rejectOnce(failure);
      });

      request.on('socket', (socket) => {
        if (!socket.connecting) connected = true;
        else socket.once('connect', () => (connected = true));
      });
      request.on('finish', () => {
        requestSent = true;
      });
      request.write(rpcPayload);
      request.end();
    });
  } finally {
    if (serverError) await invalidateRemoteDaemonHealth(info, statePaths.baseDir);
  }
}

// Loaded on the remote path only: a local daemon request never pays for the remote health cache.
const loadRemoteHealthCache = () => import('./daemon-client-remote-health-cache.ts');

/** Drops a remote daemon's cached health; a local daemon has none, so its failure loads nothing. */
export async function invalidateRemoteDaemonHealth(
  info: DaemonInfo,
  stateDir: string,
): Promise<void> {
  if (!info.baseUrl) return;
  (await loadRemoteHealthCache()).invalidateRemoteDaemonHealth(info, stateDir);
}

/** A cached `/health` record, read with the same contract checks as a live answer. */
export function readCachedRemoteHealthRecord(record: unknown): Partial<RemoteDaemonHealth> {
  return readHealthPayload(JSON.stringify(record ?? null));
}
