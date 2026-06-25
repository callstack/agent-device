import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { AppError } from './utils/errors.ts';
import { readNodeHttpResponseBody } from './utils/node-http.ts';
import type { DaemonRequest, DaemonResponse } from './daemon/types.ts';
import { emitDiagnostic } from './utils/diagnostics.ts';
import type { DaemonPaths, DaemonTransportPreference } from './daemon/config.ts';
import {
  readDaemonHttpProgressResponse,
  readDaemonSocketProgressResponse,
  shouldReadDaemonProgressStream,
} from './daemon-client-progress.ts';
import { buildDaemonHttpAuthHeaders, buildDaemonHttpUrl } from './daemon/http-contract.ts';
import { buildHttpRpcPayload, handleDaemonHttpResponseBody } from './daemon-client-rpc.ts';
import { handleRequestTimeout } from './daemon-client-timeout.ts';
import { isRemoteDaemon, type DaemonInfo } from './daemon-client-metadata.ts';
import { DAEMON_RPC_PROTOCOL_VERSION } from './daemon/http-health.ts';
import { readVersion } from './utils/version.ts';

type ResolvedDaemonTransport = 'socket' | 'http';

const LOCAL_DAEMON_HEALTHCHECK_TIMEOUT_MS = 500;
const REMOTE_DAEMON_HEALTHCHECK_TIMEOUT_MS = 3000;
export const DAEMON_HTTP_ENDPOINT_UNAVAILABLE_MESSAGE = 'Daemon HTTP endpoint is unavailable';
export const DAEMON_SOCKET_ENDPOINT_UNAVAILABLE_MESSAGE = 'Daemon socket endpoint is unavailable';

export type RemoteDaemonHealth = {
  reachable: boolean;
  statusCode?: number;
  service?: string;
  version?: string;
  rpcProtocolVersion?: number;
};

export async function canConnect(
  info: DaemonInfo,
  preference: DaemonTransportPreference,
): Promise<boolean> {
  const transport = chooseTransport(info, preference);
  if (await canConnectWithTransport(info, transport)) return true;

  const fallback = chooseAutoFallbackTransport(info, preference, transport);
  return fallback ? await canConnectWithTransport(info, fallback) : false;
}

async function canConnectWithTransport(
  info: DaemonInfo,
  transport: ResolvedDaemonTransport,
): Promise<boolean> {
  return transport === 'http' ? await canConnectHttp(info) : await canConnectSocket(info.port);
}

export function canConnectSocket(port: number | undefined): Promise<boolean> {
  if (!port) return Promise.resolve(false);
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
    socket.setTimeout(LOCAL_DAEMON_HEALTHCHECK_TIMEOUT_MS);
    socket.on('timeout', () => {
      finish(false);
    });
    socket.on('error', () => {
      finish(false);
    });
  });
}

function canConnectHttp(info: DaemonInfo): Promise<boolean> {
  return readDaemonHttpHealth(info).then((health) => health.reachable);
}

export async function readRemoteDaemonHealth(info: DaemonInfo): Promise<RemoteDaemonHealth> {
  const health = await readDaemonHttpHealth(info);
  if (!info.baseUrl || !health.reachable) return health;
  if (
    typeof health.rpcProtocolVersion === 'number' &&
    health.rpcProtocolVersion !== DAEMON_RPC_PROTOCOL_VERSION
  ) {
    throw new AppError('COMMAND_FAILED', 'Remote daemon RPC protocol is incompatible', {
      daemonBaseUrl: info.baseUrl,
      clientVersion: readVersion(),
      remoteVersion: health.version,
      remoteService: health.service,
      supportedRpcProtocolVersion: DAEMON_RPC_PROTOCOL_VERSION,
      remoteRpcProtocolVersion: health.rpcProtocolVersion,
      hint: 'Upgrade agent-device on the client or remote host so both support the same daemon RPC protocol.',
    });
  }
  return health;
}

function readDaemonHttpHealth(info: DaemonInfo): Promise<RemoteDaemonHealth> {
  const endpoint = info.baseUrl
    ? buildDaemonHttpUrl(info.baseUrl, 'health')
    : info.httpPort
      ? `http://127.0.0.1:${info.httpPort}/health`
      : null;
  if (!endpoint) return Promise.resolve({ reachable: false });
  const url = new URL(endpoint);
  const transport = url.protocol === 'https:' ? https : http;
  const timeoutMs = info.baseUrl
    ? REMOTE_DAEMON_HEALTHCHECK_TIMEOUT_MS
    : LOCAL_DAEMON_HEALTHCHECK_TIMEOUT_MS;
  return new Promise((resolve) => {
    const headers = info.baseUrl ? buildDaemonHttpAuthHeaders(info.token) : {};
    const req = transport.request(
      {
        protocol: url.protocol,
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'GET',
        timeout: timeoutMs,
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
          resolve({
            reachable: statusCode < 500,
            statusCode,
            ...readHealthPayload(body),
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ reachable: false });
    });
    req.on('error', () => {
      resolve({ reachable: false });
    });
    req.end();
  });
}

function readHealthPayload(body: string): Omit<RemoteDaemonHealth, 'reachable' | 'statusCode'> {
  try {
    const parsed = JSON.parse(body) as {
      service?: unknown;
      version?: unknown;
      rpcProtocolVersion?: unknown;
    };
    return {
      service: typeof parsed.service === 'string' ? parsed.service : undefined,
      version: typeof parsed.version === 'string' ? parsed.version : undefined,
      rpcProtocolVersion:
        typeof parsed.rpcProtocolVersion === 'number' ? parsed.rpcProtocolVersion : undefined,
    };
  } catch {
    return {};
  }
}

export async function sendRequest(
  info: DaemonInfo,
  req: DaemonRequest,
  preference: DaemonTransportPreference,
  statePaths: DaemonPaths,
  timeoutMs: number | undefined,
): Promise<DaemonResponse> {
  const transport = chooseTransport(info, preference);
  try {
    return await sendRequestWithTransport(info, req, statePaths, timeoutMs, transport);
  } catch (error) {
    const fallback = chooseAutoFallbackTransport(info, preference, transport);
    if (!fallback || !isSafeAutoTransportFallbackError(error, transport)) throw error;
    return await sendRequestWithTransport(info, req, statePaths, timeoutMs, fallback);
  }
}

async function sendRequestWithTransport(
  info: DaemonInfo,
  req: DaemonRequest,
  statePaths: DaemonPaths,
  timeoutMs: number | undefined,
  transport: ResolvedDaemonTransport,
): Promise<DaemonResponse> {
  return transport === 'http'
    ? await sendHttpRequest(info, req, statePaths, timeoutMs)
    : await sendSocketRequest(info, req, statePaths, timeoutMs);
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
  throw new AppError(
    'COMMAND_FAILED',
    transport === 'http'
      ? DAEMON_HTTP_ENDPOINT_UNAVAILABLE_MESSAGE
      : DAEMON_SOCKET_ENDPOINT_UNAVAILABLE_MESSAGE,
  );
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
  statePaths: DaemonPaths,
  timeoutMs: number | undefined,
): Promise<DaemonResponse> {
  const port = info.port;
  if (!port) throw new AppError('COMMAND_FAILED', DAEMON_SOCKET_ENDPOINT_UNAVAILABLE_MESSAGE);
  return new Promise((resolve, reject) => {
    let requestWritten = false;
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      requestWritten = true;
      socket.write(`${JSON.stringify(req)}\n`);
    });
    let settled = false;
    const timeoutHandle =
      typeof timeoutMs === 'number'
        ? setTimeout(() => {
            settled = true;
            socket.destroy();
            reject(
              handleRequestTimeout(
                info,
                statePaths,
                req.meta?.requestId,
                req.command,
                false,
                timeoutMs,
              ),
            );
          }, timeoutMs)
        : undefined;

    readDaemonSocketProgressResponse(socket, {
      req,
      isSettled: () => settled,
      clearTimeout: () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      },
      resolve: (response) => {
        settled = true;
        resolve(response);
      },
      reject: (error) => {
        settled = true;
        reject(error);
      },
    });

    socket.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(
        handleTransportError(err, req.meta?.requestId, false, {
          daemonSocketRequestWritten: requestWritten,
        }),
      );
    });
  });
}

async function sendHttpRequest(
  info: DaemonInfo,
  req: DaemonRequest,
  statePaths: DaemonPaths,
  timeoutMs: number | undefined,
): Promise<DaemonResponse> {
  const rpcUrl = info.baseUrl
    ? new URL(buildDaemonHttpUrl(info.baseUrl, 'rpc'))
    : info.httpPort
      ? new URL(`http://127.0.0.1:${info.httpPort}/rpc`)
      : null;
  if (!rpcUrl) throw new AppError('COMMAND_FAILED', DAEMON_HTTP_ENDPOINT_UNAVAILABLE_MESSAGE);
  const rpcPayload = JSON.stringify(buildHttpRpcPayload(req, { includeTokenParam: !info.baseUrl }));
  const headers: Record<string, string | number> = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(rpcPayload),
  };
  if (info.baseUrl) {
    Object.assign(headers, buildDaemonHttpAuthHeaders(info.token));
  }

  return await new Promise((resolve, reject) => {
    const transport = rpcUrl.protocol === 'https:' ? https : http;
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
        if (shouldReadDaemonProgressStream(req, res.headers?.['content-type'])) {
          readDaemonHttpProgressResponse(res, {
            req,
            reject,
            clearTimeout: () => {
              if (timeoutHandle) clearTimeout(timeoutHandle);
            },
            handleResponseBody: (body) =>
              handleDaemonHttpResponseBody(body, { info, req, resolve, reject }),
          });
          return;
        }
        void readNodeHttpResponseBody(res)
          .then((body) => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            handleDaemonHttpResponseBody(body, { info, req, resolve, reject });
          })
          .catch((err: unknown) => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            reject(
              new AppError(
                'COMMAND_FAILED',
                'Failed to read daemon response',
                { requestId: req.meta?.requestId },
                err instanceof Error ? err : undefined,
              ),
            );
          });
      },
    );

    const remote = isRemoteDaemon(info);
    const timeoutHandle =
      typeof timeoutMs === 'number'
        ? setTimeout(() => {
            request.destroy();
            reject(
              handleRequestTimeout(
                info,
                statePaths,
                req.meta?.requestId,
                req.command,
                remote,
                timeoutMs,
              ),
            );
          }, timeoutMs)
        : undefined;

    request.on('error', (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(handleTransportError(err, req.meta?.requestId, remote));
    });

    request.write(rpcPayload);
    request.end();
  });
}
