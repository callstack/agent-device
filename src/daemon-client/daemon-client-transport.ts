import type { RequestProgressSink } from '@agent-device/contracts/progress';
import net from 'node:net';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { loadNodeHttpRequester, readNodeHttpResponseBody } from '@agent-device/host-kit/transport';
import type { DaemonRequest, DaemonResponse } from '../daemon/daemon-request.ts';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { DaemonPaths, DaemonTransportPreference } from '../daemon-resolution.ts';
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
  DAEMON_HTTP_UPSTREAM_INSTANCE_HEADER,
  DAEMON_RPC_PROTOCOL_VERSION,
} from '@agent-device/contracts/daemon-http';
import { buildHttpRpcPayload, handleDaemonHttpResponseBody } from './daemon-client-rpc.ts';
import { handleRequestTimeout } from './daemon-client-timeout.ts';
import { isRemoteDaemon, type DaemonInfo } from './daemon-client-metadata.ts';
import { readVersion } from '@agent-device/host-kit/version';

type ResolvedDaemonTransport = 'socket' | 'http';
type SendRequestOptions = {
  onProgress?: RequestProgressSink;
  /**
   * The caller's per-request cancellation (#3178). Aborted at or before a send attempt, nothing
   * leaves on that attempt; aborted in flight, the attempt's own connection is destroyed — which is
   * what makes the daemon mark the request canceled — and the promise rejects with the typed
   * canceled-request error. An abort is never a timeout: it never reaches `handleRequestTimeout`.
   */
  signal?: AbortSignal;
};

/**
 * The requester-side half of a per-call `AbortSignal` (#3178), kept beside the transport that
 * enforces it so cancellation has one owner across both halves. The transport half closes the
 * request's connection (which is what makes the daemon mark the request canceled); this half
 * answers for the cases a transport cannot observe:
 *
 * - a signal already aborted before anything is sent — nothing may leave the process, so the refusal
 *   carries `details.dispatched: 'no'`;
 * - an abort during a phase with no connection to close, or a custom transport that ignores the
 *   signal — the caller's promise still settles, with `details.dispatched: 'unknown'` because the
 *   request may already have been written.
 *
 * Both reject with the typed canceled-request error (`details.reason: 'request_canceled'`) whatever
 * reason the caller aborted with, so every layer dispatches on the same reason and never on the
 * caller's arbitrary abort reason or on error text. An abort is never a timeout: nothing here reads
 * or extends a request deadline, and no timeout path may produce this rejection.
 */

/**
 * The typed canceled-request error for a caller's own abort. The reason the caller aborted with
 * survives unchanged as the cause — `AbortController.abort()` accepts any value — while the
 * rejection itself dispatches on `reason: 'request_canceled'` with the delivery evidence the
 * aborting layer can prove. A built-in transport rejects every abort through this, so a caller's
 * arbitrary abort reason never escapes as the outcome of a daemon request.
 */
function abortedRequestError(
  signal: AbortSignal,
  dispatched: 'no' | 'unknown',
  requestId?: string,
): AppError {
  return createRequestCanceledError({ requestId, dispatched }, signal.reason);
}

/**
 * Refuses a send attempt that starts while the caller's signal is already aborted: nothing may leave
 * the process, so this never touches a connection and the refusal carries `details.dispatched: 'no'`.
 */
function refuseAbortedRequest(signal: AbortSignal | undefined, requestId?: string): void {
  if (!signal?.aborted) return;
  throw abortedRequestError(signal, 'no', requestId);
}

type RequestGuard = {
  /** Refuses an already-aborted call before anything is sent. No-op without a signal. */
  refuseIfAborted(): void;
  /** Settles `send`'s outcome against the signal, winning with the typed canceled error on abort. */
  guard<T>(send: () => Promise<T>): Promise<T>;
};

const NO_REQUEST_GUARD: RequestGuard = {
  refuseIfAborted: () => {},
  guard: async <T>(send: () => Promise<T>) => await send(),
};

export function createRequestGuard(params: {
  signal: AbortSignal | undefined;
  requestId?: string;
}): RequestGuard {
  const { signal, requestId } = params;
  if (!signal) return NO_REQUEST_GUARD;
  return {
    refuseIfAborted() {
      if (signal.aborted) throw abortedRequestError(signal, 'no', requestId);
    },
    guard: async <T>(send: () => Promise<T>): Promise<T> => {
      // Checked before `send` runs, so nothing has been dispatched yet — the honest evidence is
      // 'no'. An abort listener attached to an already-aborted signal never fires, so this check is
      // what keeps a late `guard` call rejecting rather than pending forever.
      if (signal.aborted) throw abortedRequestError(signal, 'no', requestId);
      return await new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(abortedRequestError(signal, 'unknown', requestId));
        signal.addEventListener('abort', onAbort, { once: true });
        void send().then(
          (value) => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
          },
          (error: unknown) => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
          },
        );
      });
    },
  };
}

const LOCAL_DAEMON_HEALTHCHECK_TIMEOUT_MS = 500;
const REMOTE_DAEMON_HEALTHCHECK_TIMEOUT_MS = 3000;
const DAEMON_ENDPOINT_UNAVAILABLE_REASON = 'daemon_endpoint_unavailable';

export function isDaemonTransportUnavailableError(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === 'COMMAND_FAILED' &&
    error.details?.reason === DAEMON_ENDPOINT_UNAVAILABLE_REASON
  );
}

function daemonEndpointUnavailableError(transport: ResolvedDaemonTransport): AppError {
  return new AppError(
    'COMMAND_FAILED',
    transport === 'http'
      ? 'Daemon HTTP endpoint is unavailable'
      : 'Daemon socket endpoint is unavailable',
    { reason: DAEMON_ENDPOINT_UNAVAILABLE_REASON, transport },
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
  /** The daemon behind a proxy, as the proxy's health reported it. */
  upstream?: RemoteDaemonHealthLink;
  /** The probe ran out of its time budget before an answer, rather than failing outright. */
  timedOut?: true;
};

type RemoteDaemonHealthLink = Pick<
  RemoteDaemonHealth,
  'service' | 'version' | 'rpcProtocolVersion' | 'instanceId' | 'hostArch'
>;

export async function canConnect(
  info: DaemonInfo,
  preference: DaemonTransportPreference,
  probeTimeoutMs?: number,
): Promise<boolean> {
  const deadline = Date.now() + (probeTimeoutMs ?? Number.POSITIVE_INFINITY);
  const transport = chooseTransport(info, preference);
  const fallback = chooseAutoFallbackTransport(info, preference, transport);
  const firstBudget = (deadline - Date.now()) / (fallback ? 2 : 1);
  if (await canConnectWithTransport(info, transport, firstBudget)) return Date.now() < deadline;
  return fallback
    ? (await canConnectWithTransport(info, fallback, deadline - Date.now())) &&
        Date.now() < deadline
    : false;
}

async function canConnectWithTransport(
  info: DaemonInfo,
  transport: ResolvedDaemonTransport,
  timeoutMs: number,
): Promise<boolean> {
  return transport === 'http'
    ? await canConnectHttp(info, timeoutMs)
    : await canConnectSocket(info.port, timeoutMs);
}

export function canConnectSocket(
  port: number | undefined,
  timeoutMs = LOCAL_DAEMON_HEALTHCHECK_TIMEOUT_MS,
): Promise<boolean> {
  if (!port || timeoutMs <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      finish(true);
    });
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(Math.min(LOCAL_DAEMON_HEALTHCHECK_TIMEOUT_MS, Math.ceil(timeoutMs)));
    socket.on('timeout', () => {
      finish(false);
    });
    socket.on('error', () => {
      finish(false);
    });
  });
}

function canConnectHttp(info: DaemonInfo, timeoutMs: number): Promise<boolean> {
  return readDaemonHttpHealth(info, timeoutMs).then((health) => health.reachable);
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
    (link) =>
      typeof link?.rpcProtocolVersion === 'number' &&
      link.rpcProtocolVersion !== DAEMON_RPC_PROTOCOL_VERSION,
  );
  if (incompatible) {
    throw new AppError('COMMAND_FAILED', 'Remote daemon RPC protocol is incompatible', {
      daemonBaseUrl: info.baseUrl,
      clientVersion: readVersion(),
      remoteVersion: incompatible.version,
      remoteService: incompatible.service,
      supportedRpcProtocolVersion: DAEMON_RPC_PROTOCOL_VERSION,
      remoteRpcProtocolVersion: incompatible.rpcProtocolVersion,
      hint: 'Upgrade agent-device on the client or remote host so both support the same daemon RPC protocol.',
    });
  }
  return health;
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
    service: typeof parsed.service === 'string' ? parsed.service : undefined,
    version: typeof parsed.version === 'string' ? parsed.version : undefined,
    rpcProtocolVersion:
      typeof parsed.rpcProtocolVersion === 'number' ? parsed.rpcProtocolVersion : undefined,
    ...(typeof parsed.instanceId === 'string' ? { instanceId: parsed.instanceId } : {}),
    ...(typeof parsed.hostArch === 'string' ? { hostArch: parsed.hostArch } : {}),
  };
}

export async function sendRequest(
  info: DaemonInfo,
  req: DaemonRequest,
  preference: DaemonTransportPreference,
  statePaths: DaemonPaths,
  timeoutMs: number | undefined,
  options: SendRequestOptions = {},
): Promise<DaemonResponse> {
  try {
    return await sendRequestWithFallback(info, req, preference, statePaths, timeoutMs, options);
  } catch (error) {
    if (!(error instanceof AppError) || error.details?.reason !== 'daemon_transport_timeout')
      throw error;
    const expiredBudget = error.details.timeoutMs;
    if (typeof expiredBudget !== 'number') throw error;
    throw await handleRequestTimeout({
      info,
      statePaths,
      ...timeoutRequestContext(req, isRemoteDaemon(info), expiredBudget),
    });
  }
}

async function sendRequestWithFallback(
  info: DaemonInfo,
  req: DaemonRequest,
  preference: DaemonTransportPreference,
  statePaths: DaemonPaths,
  timeoutMs: number | undefined,
  options: SendRequestOptions = {},
): Promise<DaemonResponse> {
  const transport = chooseTransport(info, preference);
  const deadline = typeof timeoutMs === 'number' ? performance.now() + timeoutMs : undefined;
  // A canceled caller must not open a connection just to lose it, and a fallback or instance retry
  // that begins after the abort must not send either — every attempt starts behind this check.
  refuseAbortedRequest(options.signal, req.meta?.requestId);
  try {
    return await sendRequestWithTransport(info, req, statePaths, timeoutMs, transport, options);
  } catch (error) {
    if (info.baseUrl && isRemoteInstanceMismatch(error)) {
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
    if (isRemoteTransportFailure(error)) invalidateRemoteDaemonHealth(info);
    const fallback = chooseAutoFallbackTransport(info, preference, transport);
    if (!fallback || !isSafeAutoTransportFallbackError(error, transport)) throw error;
    return await sendRequestWithTransport(info, req, statePaths, timeoutMs, fallback, options);
  }
}

async function retryAfterRemoteInstanceMismatch(
  info: DaemonInfo,
  req: DaemonRequest,
  statePaths: DaemonPaths,
  timeoutMs: number | undefined,
  deadline: number | undefined,
  transport: ResolvedDaemonTransport,
  options: SendRequestOptions,
): Promise<DaemonResponse> {
  invalidateRemoteDaemonHealth(info);
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
    throw new AppError('COMMAND_FAILED', 'Remote daemon is unavailable', {
      daemonBaseUrl: info.baseUrl,
    });
  }
  info.remoteInstanceId = health.instanceId;
  info.remoteUpstreamInstanceId = health.upstream?.instanceId;
  cacheRemoteDaemonHealth(info, health);
  try {
    return await sendRequestWithTransport(info, req, statePaths, remainingMs, transport, options);
  } catch (error) {
    if (isRemoteTransportFailure(error)) invalidateRemoteDaemonHealth(info);
    throw error;
  }
}

function remainingRemoteRequestTimeoutMs(
  req: DaemonRequest,
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
  throw requestTimeoutError(timeoutMs, req.meta?.requestId);
}

function isRemoteInstanceMismatch(error: unknown): boolean {
  return error instanceof AppError && error.details?.reason === 'remote_instance_mismatch';
}

function isRemoteTransportFailure(error: unknown): boolean {
  return (
    error instanceof AppError &&
    (error.details?.reason === 'daemon_transport_failure' ||
      error.details?.reason === 'daemon_transport_timeout' ||
      error.details?.reason === 'daemon_response_read_failure')
  );
}

async function sendRequestWithTransport(
  info: DaemonInfo,
  req: DaemonRequest,
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
    error.code === 'COMMAND_FAILED' &&
    error.message === 'Failed to communicate with daemon' &&
    error.details?.daemonSocketRequestWritten === false
  );
}

function requireDaemonTransport(
  info: DaemonInfo,
  transport: ResolvedDaemonTransport,
): ResolvedDaemonTransport {
  if (hasDaemonTransport(info, transport)) return transport;
  throw daemonEndpointUnavailableError(transport);
}

function handleTransportError(
  err: unknown,
  requestId: string | undefined,
  remote: boolean,
  details: Record<string, unknown> = {},
): AppError {
  emitDiagnostic({
    level: 'error',
    phase: 'daemon_request_socket_error',
    data: {
      requestId,
      message: err instanceof Error ? (err as Error).message : String(err),
    },
  });
  return new AppError(
    'COMMAND_FAILED',
    'Failed to communicate with daemon',
    {
      ...details,
      reason: 'daemon_transport_failure',
      requestId,
      hint: remote
        ? 'Retry command. If this persists, verify the remote daemon URL, auth token, and remote host reachability.'
        : 'Retry command. If this persists, clean stale daemon metadata and start a fresh session.',
    },
    err instanceof Error ? err : undefined,
  );
}

async function sendSocketRequest(
  info: DaemonInfo,
  req: DaemonRequest,
  timeoutMs: number | undefined,
  options: SendRequestOptions,
): Promise<DaemonResponse> {
  const port = info.port;
  if (!port) throw daemonEndpointUnavailableError('socket');
  const callerSignal = options.signal;
  refuseAbortedRequest(callerSignal, req.meta?.requestId);
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
      socket.write(`${JSON.stringify(req)}\n`);
    });
    const timeoutHandle =
      typeof timeoutMs === 'number'
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            detachCallerAbort();
            reject(requestTimeoutError(timeoutMs, req.meta?.requestId));
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
      reject(
        handleTransportError(err, req.meta?.requestId, false, {
          daemonSocketRequestWritten: requestWritten,
        }),
      );
    });
  });
}

function requestTimeoutError(timeoutMs: number, requestId: string | undefined): AppError {
  return new AppError('COMMAND_FAILED', 'Daemon request timed out', {
    reason: 'daemon_transport_timeout',
    timeoutMs,
    requestId,
  });
}

// The fields a timed-out request is described by, read once so a socket and an HTTP timeout cannot
// describe the same request differently.
type TimeoutRequestFields = Omit<Parameters<typeof handleRequestTimeout>[0], 'info' | 'statePaths'>;

function timeoutRequestContext(
  req: DaemonRequest,
  remote: boolean,
  timeoutMs: number,
): TimeoutRequestFields {
  return {
    remote,
    timeoutMs,
    requestId: req.meta?.requestId,
    command: req.command,
    platform: req.flags?.platform,
    session: req.session,
    action: req.positionals?.[0],
  };
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
  req: DaemonRequest,
  statePaths: DaemonPaths,
  timeoutMs: number | undefined,
  options: SendRequestOptions,
): Promise<DaemonResponse> {
  const rpcEndpoint = daemonHttpEndpoint(info, 'rpc');
  if (!rpcEndpoint) throw daemonEndpointUnavailableError('http');
  const rpcUrl = new URL(rpcEndpoint);
  const rpcPayload = JSON.stringify(buildHttpRpcPayload(req, { includeTokenParam: !info.baseUrl }));
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

  return await new Promise((resolve, reject) => {
    let settled = false;
    let requestEnded = false;
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
        if (isRemoteInstanceMismatchResponse(res.statusCode, res.headers ?? {})) {
          res.resume();
          if (timeoutHandle) clearTimeout(timeoutHandle);
          rejectOnce(
            new AppError('COMMAND_FAILED', 'Remote daemon instance changed', {
              reason: 'remote_instance_mismatch',
              daemonBaseUrl: info.baseUrl,
            }),
          );
          return;
        }
        if (shouldReadDaemonProgressStream(req, res.headers?.['content-type'])) {
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
            { requestId: req.meta?.requestId, reason: 'daemon_response_read_failure' },
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
            rejectOnce(requestTimeoutError(timeoutMs, req.meta?.requestId));
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
        abortedRequestError(callerSignal!, requestEnded ? 'unknown' : 'no', req.meta?.requestId),
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
      rejectOnce(handleTransportError(err, req.meta?.requestId, remote));
    });

    request.write(rpcPayload);
    request.end();
    requestEnded = true;
  });
}

type RemoteHealthCacheEntry = {
  baseUrl: string;
  token: string;
  pid: number;
  health: Promise<RemoteDaemonHealth>;
};

let remoteHealthCache: RemoteHealthCacheEntry | undefined;

function matchesRemoteIdentity(entry: RemoteHealthCacheEntry, info: DaemonInfo): boolean {
  return entry.baseUrl === info.baseUrl && entry.token === info.token && entry.pid === info.pid;
}

function cacheRemoteDaemonHealth(info: DaemonInfo, health: RemoteDaemonHealth): void {
  if (!health.instanceId || (health.upstream && !health.upstream.instanceId)) return;
  remoteHealthCache = {
    baseUrl: info.baseUrl ?? '',
    token: info.token,
    pid: info.pid,
    health: Promise.resolve(health),
  };
}

function invalidateRemoteDaemonHealth(info: DaemonInfo): void {
  if (remoteHealthCache && matchesRemoteIdentity(remoteHealthCache, info)) {
    remoteHealthCache = undefined;
  }
}

export async function cachedRemoteDaemonHealth(info: DaemonInfo): Promise<RemoteDaemonHealth> {
  if (remoteHealthCache && matchesRemoteIdentity(remoteHealthCache, info)) {
    return await remoteHealthCache.health;
  }
  const entry: RemoteHealthCacheEntry = {
    baseUrl: info.baseUrl ?? '',
    token: info.token,
    pid: info.pid,
    health: readRemoteDaemonHealth(info),
  };
  remoteHealthCache = entry;
  try {
    const health = await entry.health;
    if (
      (!health.reachable ||
        !health.instanceId ||
        (health.upstream && !health.upstream.instanceId)) &&
      remoteHealthCache === entry
    ) {
      remoteHealthCache = undefined;
    }
    return health;
  } catch (error) {
    if (remoteHealthCache === entry) remoteHealthCache = undefined;
    throw error;
  }
}
