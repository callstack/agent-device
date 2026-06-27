import http, { type IncomingHttpHeaders } from 'node:http';
import fs from 'node:fs';
import { AppError, normalizeError, toAppErrorCode } from '../utils/errors.ts';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import { timingSafeStringEqual } from '../utils/timing-safe-equal.ts';
import type {
  CommandRpcParams,
  JsonRpcId,
  JsonRpcRequestEnvelope,
  LeaseBackend,
} from '../contracts.ts';
import { commandRpcParamsSchema } from '../contracts.ts';
import type { DaemonInstallSource, DaemonInvokeFn, DaemonRequest } from './types.ts';
import { normalizeTenantId } from './config.ts';
import {
  clearRequestCanceled,
  isRequestCanceled,
  markRequestCanceled,
  registerRequestAbort,
  resolveRequestTrackingId,
} from './request-cancel.ts';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sleep } from '../utils/timeouts.ts';
import {
  cleanupDownloadableArtifact,
  prepareDownloadableArtifact,
  trackUploadedArtifact,
} from './artifact-tracking.ts';
import { receiveUpload } from './upload.ts';
import { type RequestProgressEvent, withRequestProgressSink } from './request-progress.ts';
import {
  serializeDaemonProgressEnvelope,
  serializeDaemonRpcResponseEnvelope,
  shouldStreamRequestProgress,
} from './request-progress-protocol.ts';
import { buildDaemonHealthPayload } from './http-health.ts';

type JsonRpcRequest = JsonRpcRequestEnvelope;

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: Record<string, unknown>;
  };
};

export type HttpAuthHookContext = {
  headers: IncomingHttpHeaders;
  rpcRequest: JsonRpcRequest;
  daemonRequest: DaemonRequest;
};

export type HttpAuthHookResult =
  | boolean
  | void
  | {
      ok?: boolean;
      tenantId?: string;
      code?: string;
      message?: string;
      details?: Record<string, unknown>;
    };

export type HttpAuthHook = (
  context: HttpAuthHookContext,
) => Promise<HttpAuthHookResult> | HttpAuthHookResult;

type HttpAuthDecision =
  | { ok: true; tenantId?: string }
  | { ok: false; statusCode: number; response: JsonRpcResponse };

const MAX_HTTP_RPC_BODY_BYTES = 1024 * 1024;
const CLIENT_DISCONNECT_ABORT_POLL_INTERVAL_MS = 200;
const CLIENT_DISCONNECT_ABORT_MAX_WINDOW_MS = 15_000;
const IOS_RUNNER_ABORT_REPLAY_COMMANDS = new Set(['replay', 'test']);
const COMMAND_RPC_METHODS = new Set(['agent_device.command', 'agent-device.command']);
const INSTALL_FROM_SOURCE_RPC_METHODS = new Set([
  'agent_device.install_from_source',
  'agent-device.install_from_source',
]);
const RELEASE_MATERIALIZED_PATHS_RPC_METHODS = new Set([
  'agent_device.release_materialized_paths',
  'agent-device.release_materialized_paths',
]);
const LEASE_RPC_METHOD_TO_COMMAND: Record<
  string,
  'lease_allocate' | 'lease_heartbeat' | 'lease_release'
> = {
  'agent_device.lease.allocate': 'lease_allocate',
  'agent-device.lease.allocate': 'lease_allocate',
  'agent_device.lease.heartbeat': 'lease_heartbeat',
  'agent-device.lease.heartbeat': 'lease_heartbeat',
  'agent_device.lease.release': 'lease_release',
  'agent-device.lease.release': 'lease_release',
};
const SUPPORTED_RPC_METHODS = new Set([
  ...COMMAND_RPC_METHODS,
  ...INSTALL_FROM_SOURCE_RPC_METHODS,
  ...RELEASE_MATERIALIZED_PATHS_RPC_METHODS,
  ...Object.keys(LEASE_RPC_METHOD_TO_COMMAND),
]);

function createRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, data },
  };
}

function sendJson(
  res: http.ServerResponse<http.IncomingMessage>,
  response: JsonRpcResponse,
  httpCode: number = 200,
): void {
  res.statusCode = httpCode;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(response));
}

function writeProgressEnvelope(
  res: http.ServerResponse<http.IncomingMessage>,
  event: RequestProgressEvent,
): void {
  if (res.destroyed) return;
  res.write(serializeDaemonProgressEnvelope(event));
}

function writeRpcResponseEnvelope(
  res: http.ServerResponse<http.IncomingMessage>,
  response: JsonRpcResponse,
): void {
  if (res.destroyed) return;
  res.write(serializeDaemonRpcResponseEnvelope(response));
  res.end();
}

function statusCodeForNormalizedError(code: string): number {
  switch (code) {
    case 'INVALID_ARGS':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'SESSION_NOT_FOUND':
      return 404;
    default:
      return 500;
  }
}

// Map a thrown boundary error to its JSON-RPC error code. Invalid params (malformed
// wire input rejected before the request reaches the handler) is JSON-RPC -32602, to
// match the explicit `Invalid params` sibling checks below; everything else is the
// generic application error -32000.
function jsonRpcCodeForNormalizedError(code: string): number {
  return code === 'INVALID_ARGS' ? -32602 : -32000;
}

function resolveToken(params: Record<string, unknown>, headers: IncomingHttpHeaders): string {
  const authHeader = typeof headers.authorization === 'string' ? headers.authorization : '';
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice('bearer '.length)
    : undefined;
  const headerToken =
    typeof headers['x-agent-device-token'] === 'string'
      ? headers['x-agent-device-token']
      : undefined;
  const paramToken = typeof params.token === 'string' ? params.token : undefined;
  return paramToken ?? headerToken ?? bearerToken ?? '';
}

function toDaemonRequest(params: CommandRpcParams, headers: IncomingHttpHeaders): DaemonRequest {
  return {
    token: resolveToken(params as Record<string, unknown>, headers),
    session: params.session ?? 'default',
    command: params.command ?? '',
    positionals: params.positionals ?? [],
    // flags/runtime/meta are validated as objects at the boundary; their full shape is
    // validated in the session open handler downstream.
    flags: params.flags as DaemonRequest['flags'],
    runtime: params.runtime,
    meta: params.meta as DaemonRequest['meta'],
  };
}

function readStringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' ? value : undefined;
}

function readIntParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  return Number.isInteger(value) ? Number(value) : undefined;
}

function readBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readRequiredGitHubArtifactText(
  record: Record<string, unknown>,
  key: 'owner' | 'repo' | 'artifactName',
): string {
  const value = typeof record[key] === 'string' ? record[key].trim() : '';
  if (!value) {
    throw new AppError(
      'INVALID_ARGS',
      `Invalid params: source.${key} is required for github-actions-artifact sources`,
    );
  }
  return value;
}

function readGitHubArtifactInteger(record: Record<string, unknown>, key: 'artifactId' | 'runId') {
  const value = record[key];
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isInteger(parsed)) {
    throw new AppError('INVALID_ARGS', `Invalid params: source.${key} must be an integer`);
  }
  return parsed;
}

function parseGitHubActionsArtifactSource(record: Record<string, unknown>): DaemonInstallSource {
  const owner = readRequiredGitHubArtifactText(record, 'owner');
  const repo = readRequiredGitHubArtifactText(record, 'repo');
  const hasArtifactId = record.artifactId !== undefined;
  const hasRunId = record.runId !== undefined;
  const hasArtifactName = record.artifactName !== undefined;
  if (hasArtifactId && (hasRunId || hasArtifactName)) {
    throw new AppError(
      'INVALID_ARGS',
      'Invalid params: source must specify either artifactId or artifactName, not both',
    );
  }
  if (!hasArtifactId && hasRunId && !hasArtifactName) {
    throw new AppError(
      'INVALID_ARGS',
      'Invalid params: source.artifactName is required when source.runId is specified',
    );
  }
  if (!hasArtifactId && !hasArtifactName) {
    throw new AppError(
      'INVALID_ARGS',
      'Invalid params: source must specify artifactId or artifactName',
    );
  }
  if (hasArtifactId) {
    return {
      kind: 'github-actions-artifact',
      owner,
      repo,
      artifactId: readGitHubArtifactInteger(record, 'artifactId'),
    };
  }
  let runId: number | undefined;
  if (hasRunId) {
    runId = readGitHubArtifactInteger(record, 'runId');
  }
  return {
    kind: 'github-actions-artifact',
    owner,
    repo,
    ...(hasRunId ? { runId } : {}),
    artifactName: readRequiredGitHubArtifactText(record, 'artifactName'),
  };
}

function toLeaseDaemonRequest(
  command: 'lease_allocate' | 'lease_heartbeat' | 'lease_release',
  params: Record<string, unknown>,
  headers: IncomingHttpHeaders,
): DaemonRequest {
  return {
    token: resolveToken(params, headers),
    session: readStringParam(params, 'session') ?? 'default',
    command,
    positionals: [],
    meta: {
      tenantId: readStringParam(params, 'tenantId') ?? readStringParam(params, 'tenant'),
      runId: readStringParam(params, 'runId'),
      leaseId: readStringParam(params, 'leaseId'),
      leaseTtlMs: readIntParam(params, 'ttlMs'),
      leaseBackend: readStringParam(params, 'backend') as LeaseBackend | undefined,
      leaseProvider:
        readStringParam(params, 'leaseProvider') ?? readStringParam(params, 'provider'),
      deviceKey: readStringParam(params, 'deviceKey'),
      clientId: readStringParam(params, 'clientId'),
    },
  };
}

function parseInstallSource(params: Record<string, unknown>): DaemonInstallSource {
  const source = params.source;
  if (!source || typeof source !== 'object') {
    throw new AppError('INVALID_ARGS', 'Invalid params: source is required');
  }
  const record = source as Record<string, unknown>;
  if (record.kind === 'url') {
    const url = typeof record.url === 'string' ? record.url.trim() : '';
    if (!url) {
      throw new AppError('INVALID_ARGS', 'Invalid params: source.url is required for url sources');
    }
    const rawHeaders = record.headers;
    const headers: Record<string, string> = {};
    if (rawHeaders !== undefined) {
      if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
        throw new AppError('INVALID_ARGS', 'Invalid params: source.headers must be a string map');
      }
      for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
        if (typeof value !== 'string') {
          throw new AppError(
            'INVALID_ARGS',
            'Invalid params: source.headers values must be strings',
          );
        }
        headers[key] = value;
      }
    }
    return Object.keys(headers).length > 0 ? { kind: 'url', url, headers } : { kind: 'url', url };
  }
  if (record.kind === 'path') {
    const artifactPath = typeof record.path === 'string' ? record.path.trim() : '';
    if (!artifactPath) {
      throw new AppError(
        'INVALID_ARGS',
        'Invalid params: source.path is required for path sources',
      );
    }
    return { kind: 'path', path: artifactPath };
  }
  if (record.kind === 'github-actions-artifact') {
    return parseGitHubActionsArtifactSource(record);
  }
  throw new AppError(
    'INVALID_ARGS',
    'Invalid params: source.kind must be "url", "path", or "github-actions-artifact"',
  );
}

function toInstallFromSourceDaemonRequest(
  params: Record<string, unknown>,
  headers: IncomingHttpHeaders,
): DaemonRequest {
  const platform = readStringParam(params, 'platform');
  if (platform !== 'ios' && platform !== 'android') {
    throw new AppError('INVALID_ARGS', 'Invalid params: platform must be "ios" or "android"');
  }
  return {
    token: resolveToken(params, headers),
    session: readStringParam(params, 'session') ?? 'default',
    command: 'install_source',
    positionals: [],
    flags: { platform },
    meta: {
      requestId: readStringParam(params, 'requestId'),
      installSource: parseInstallSource(params),
      retainMaterializedPaths: readBooleanParam(params, 'retainPaths'),
      materializedPathRetentionMs: readIntParam(params, 'retentionMs'),
    },
  };
}

function toReleaseMaterializedPathsDaemonRequest(
  params: Record<string, unknown>,
  headers: IncomingHttpHeaders,
): DaemonRequest {
  const materializationId = readStringParam(params, 'materializationId')?.trim();
  if (!materializationId) {
    throw new AppError('INVALID_ARGS', 'Invalid params: materializationId is required');
  }
  return {
    token: resolveToken(params, headers),
    session: readStringParam(params, 'session') ?? 'default',
    command: 'release_materialized_paths',
    positionals: [],
    meta: {
      requestId: readStringParam(params, 'requestId'),
      materializationId,
    },
  };
}

// The runtime schema reports failures with an internal JSON-path prefix
// (e.g. `$.positionals: Expected an array`). Strip the `$` sigil so the wire message
// stays user-facing without leaking the schema's internal path representation.
function cleanSchemaParseMessage(message: string): string {
  const separator = message.indexOf(': ');
  if (separator === -1 || !message.startsWith('$')) return message;
  const field = message.slice(0, separator).replace(/^\$\.?/, '');
  const detail = message.slice(separator + 2);
  return field ? `${field}: ${detail}` : detail;
}

// Validate the command params at the boundary so malformed client input is rejected as
// INVALID_ARGS (-> JSON-RPC -32602 / HTTP 400) instead of leaking as an internal 500.
function parseCommandRpcParams(params: Record<string, unknown>): CommandRpcParams {
  try {
    return commandRpcParamsSchema.parse(params);
  } catch (error) {
    const detail =
      error instanceof Error ? cleanSchemaParseMessage(error.message) : 'invalid command params';
    throw new AppError('INVALID_ARGS', `Invalid params: ${detail}`);
  }
}

function methodToDaemonRequest(
  method: string,
  params: Record<string, unknown>,
  headers: IncomingHttpHeaders,
): DaemonRequest {
  if (COMMAND_RPC_METHODS.has(method)) {
    return toDaemonRequest(parseCommandRpcParams(params), headers);
  }
  if (INSTALL_FROM_SOURCE_RPC_METHODS.has(method)) {
    return toInstallFromSourceDaemonRequest(params, headers);
  }
  if (RELEASE_MATERIALIZED_PATHS_RPC_METHODS.has(method)) {
    return toReleaseMaterializedPathsDaemonRequest(params, headers);
  }
  const leaseCommand = LEASE_RPC_METHOD_TO_COMMAND[method];
  if (leaseCommand) {
    return toLeaseDaemonRequest(leaseCommand, params, headers);
  }
  throw new AppError('INVALID_ARGS', `Method not found: ${method}`);
}

function isCommandRpcMethod(method: string): boolean {
  return COMMAND_RPC_METHODS.has(method);
}

async function runHttpAuthHook(
  authHook: HttpAuthHook | null,
  context: HttpAuthHookContext,
): Promise<HttpAuthDecision> {
  if (!authHook) return { ok: true };
  const result = await authHook(context);
  if (result === undefined || result === true) return { ok: true };
  if (result === false) {
    const normalized = normalizeError(
      new AppError('UNAUTHORIZED', 'Request rejected by auth hook'),
    );
    return {
      ok: false,
      statusCode: 401,
      response: createRpcError(
        context.rpcRequest.id ?? null,
        -32001,
        normalized.message,
        normalized,
      ),
    };
  }
  if (result.ok === false) {
    const normalized = normalizeError(
      new AppError(
        toAppErrorCode(result.code, 'UNAUTHORIZED'),
        result.message ?? 'Request rejected by auth hook',
        result.details,
      ),
    );
    return {
      ok: false,
      statusCode: 401,
      response: createRpcError(
        context.rpcRequest.id ?? null,
        -32001,
        normalized.message,
        normalized,
      ),
    };
  }
  if (typeof result.tenantId === 'string' && result.tenantId.length > 0) {
    const tenantId = normalizeTenantId(result.tenantId);
    if (!tenantId) {
      const normalized = normalizeError(
        new AppError('INVALID_ARGS', 'Auth hook returned invalid tenantId'),
      );
      return {
        ok: false,
        statusCode: 500,
        response: createRpcError(
          context.rpcRequest.id ?? null,
          -32000,
          normalized.message,
          normalized,
        ),
      };
    }
    return { ok: true, tenantId };
  }
  return { ok: true };
}

async function loadHttpAuthHook(): Promise<HttpAuthHook | null> {
  const hookPath = process.env.AGENT_DEVICE_HTTP_AUTH_HOOK;
  if (!hookPath) return null;
  const exportName = process.env.AGENT_DEVICE_HTTP_AUTH_EXPORT || 'default';
  const resolvedPath = path.isAbsolute(hookPath) ? hookPath : path.resolve(hookPath);
  let imported: Record<string, unknown>;
  try {
    imported = (await import(pathToFileURL(resolvedPath).href)) as Record<string, unknown>;
  } catch (error) {
    throw new AppError('COMMAND_FAILED', 'Failed to load AGENT_DEVICE_HTTP_AUTH_HOOK module', {
      hookPath: resolvedPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const maybeHook = imported[exportName];
  if (typeof maybeHook !== 'function') {
    throw new AppError('INVALID_ARGS', `Auth hook export ${exportName} is not a function`, {
      hookPath: resolvedPath,
      exportName,
    });
  }
  return maybeHook as HttpAuthHook;
}

export async function createDaemonHttpServer(options: {
  handleRequest: DaemonInvokeFn;
  token?: string;
}): Promise<http.Server> {
  const authHook = await loadHttpAuthHook();
  const { handleRequest, token } = options;
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(buildDaemonHealthPayload('agent-device-daemon')));
      return;
    }

    if (req.method === 'POST' && req.url === '/upload') {
      handleUpload(req, res, authHook, token);
      return;
    }

    if (req.method === 'GET' && req.url?.startsWith('/artifacts/')) {
      void handleArtifactDownload(req, res, authHook, token);
      return;
    }

    if (req.method !== 'POST' || req.url !== '/rpc') {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }

    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_HTTP_RPC_BODY_BYTES) {
        req.destroy(new Error('request too large'));
      }
    });

    req.on('error', () => {
      if (!res.headersSent) {
        sendJson(res, createRpcError(null, -32700, 'Parse error'), 400);
      }
    });

    req.on('end', async () => {
      let rpcRequest: JsonRpcRequest;
      try {
        rpcRequest = JSON.parse(body) as JsonRpcRequest;
      } catch {
        sendJson(res, createRpcError(null, -32700, 'Parse error'), 400);
        return;
      }

      if (rpcRequest.jsonrpc !== '2.0' || typeof rpcRequest.method !== 'string') {
        sendJson(res, createRpcError(rpcRequest.id ?? null, -32600, 'Invalid Request'), 400);
        return;
      }
      if (!SUPPORTED_RPC_METHODS.has(rpcRequest.method)) {
        sendJson(
          res,
          createRpcError(rpcRequest.id ?? null, -32601, `Method not found: ${rpcRequest.method}`),
          404,
        );
        return;
      }
      if (!rpcRequest.params || typeof rpcRequest.params !== 'object') {
        sendJson(res, createRpcError(rpcRequest.id ?? null, -32602, 'Invalid params'), 400);
        return;
      }

      let requestIdForCleanup: string | undefined;
      let handlerCompleted = false;
      try {
        const params = rpcRequest.params as Record<string, unknown>;
        const daemonRequest = methodToDaemonRequest(rpcRequest.method, params, req.headers);
        if (
          isCommandRpcMethod(rpcRequest.method) &&
          (typeof daemonRequest.command !== 'string' || daemonRequest.command.length === 0)
        ) {
          sendJson(
            res,
            createRpcError(rpcRequest.id ?? null, -32602, 'Invalid params: command is required'),
            400,
          );
          return;
        }

        requestIdForCleanup = resolveRequestTrackingId(
          daemonRequest.meta?.requestId,
          rpcRequest.id,
        );
        daemonRequest.meta = {
          ...daemonRequest.meta,
          requestId: requestIdForCleanup,
        };
        registerRequestAbort(requestIdForCleanup);

        const authResult = await runHttpAuthHook(authHook, {
          headers: req.headers,
          rpcRequest,
          daemonRequest,
        });
        if (!authResult.ok) {
          sendJson(res, authResult.response, authResult.statusCode);
          return;
        }
        if (authResult.tenantId) {
          daemonRequest.meta = {
            ...daemonRequest.meta,
            tenantId: authResult.tenantId,
            sessionIsolation:
              daemonRequest.meta?.sessionIsolation ??
              daemonRequest.flags?.sessionIsolation ??
              'tenant',
          };
        }

        const abortIosRunnerOnDisconnect = shouldAbortIosRunnerSessionsOnDisconnect(daemonRequest);
        let canceledInFlight = false;
        const markCanceledIfResponseIncomplete = () => {
          if (handlerCompleted || res.writableFinished || canceledInFlight) return;
          canceledInFlight = true;
          markRequestCanceled(requestIdForCleanup);
          emitDiagnostic({
            level: 'warn',
            phase: 'request_client_disconnected',
            data: {
              requestId: requestIdForCleanup,
              abortIosRunnerSessions: abortIosRunnerOnDisconnect,
            },
          });
          if (abortIosRunnerOnDisconnect) {
            void abortInFlightIosRunnerSessionsWhileDisconnected(requestIdForCleanup);
          }
        };
        req.on('aborted', markCanceledIfResponseIncomplete);
        res.on('close', () => {
          if (res.headersSent) markCanceledIfResponseIncomplete();
        });
        if (req.aborted || (res.destroyed && res.headersSent)) {
          markCanceledIfResponseIncomplete();
        }

        const streamProgress = shouldStreamRequestProgress(daemonRequest);
        if (streamProgress) {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/x-ndjson');
          const daemonResponse = await withRequestProgressSink(
            (event) => writeProgressEnvelope(res, event),
            async () => await handleRequest(daemonRequest),
          );
          handlerCompleted = true;
          const rpcResponse = daemonResponse.ok
            ? ({
                jsonrpc: '2.0',
                id: rpcRequest.id ?? null,
                result: daemonResponse,
              } satisfies JsonRpcResponse)
            : createRpcError(
                rpcRequest.id ?? null,
                -32000,
                daemonResponse.error.message,
                daemonResponse.error,
              );
          writeRpcResponseEnvelope(res, rpcResponse);
          return;
        }

        const daemonResponse = await handleRequest(daemonRequest);
        handlerCompleted = true;
        if (daemonResponse.ok) {
          sendJson(res, { jsonrpc: '2.0', id: rpcRequest.id ?? null, result: daemonResponse });
          return;
        }
        sendJson(
          res,
          createRpcError(
            rpcRequest.id ?? null,
            -32000,
            daemonResponse.error.message,
            daemonResponse.error,
          ),
          statusCodeForNormalizedError(daemonResponse.error.code),
        );
      } catch (error) {
        handlerCompleted = true;
        const normalized = normalizeError(error);
        const rpcErrorCode = jsonRpcCodeForNormalizedError(normalized.code);
        if (res.headersSent) {
          writeRpcResponseEnvelope(
            res,
            createRpcError(rpcRequest.id ?? null, rpcErrorCode, normalized.message, normalized),
          );
          return;
        }
        sendJson(
          res,
          createRpcError(rpcRequest.id ?? null, rpcErrorCode, normalized.message, normalized),
          statusCodeForNormalizedError(normalized.code),
        );
      } finally {
        clearRequestCanceled(requestIdForCleanup);
      }
    });
  });
}

async function handleUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authHook: HttpAuthHook | null,
  expectedToken?: string,
): Promise<void> {
  try {
    const auth = await authorizeAuxiliaryHttpRequest({
      req,
      res,
      authHook,
      expectedToken,
      daemonRequest: {
        command: 'upload',
        positionals: [],
      },
    });
    if (!auth) return;

    const result = await receiveUpload(req);
    const uploadId = trackUploadedArtifact({
      artifactPath: result.artifactPath,
      tempDir: result.tempDir,
      tenantId: auth.tenantId,
    });

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, uploadId }));
  } catch (error) {
    const normalized = normalizeError(error);
    sendRestJsonError(res, normalized);
  }
}

async function handleArtifactDownload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authHook: HttpAuthHook | null,
  expectedToken?: string,
): Promise<void> {
  const artifactId = req.url?.slice('/artifacts/'.length) ?? '';
  if (!artifactId) {
    res.statusCode = 400;
    res.end('Missing artifact id');
    return;
  }
  try {
    const auth = await authorizeAuxiliaryHttpRequest({
      req,
      res,
      authHook,
      expectedToken,
      daemonRequest: {
        command: 'download_artifact',
        positionals: [artifactId],
      },
    });
    if (!auth) return;

    const artifact = prepareDownloadableArtifact(artifactId, auth.tenantId);
    const stream = fs.createReadStream(artifact.artifactPath);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/octet-stream');
    if (artifact.fileName) {
      res.setHeader(
        'content-disposition',
        `attachment; filename="${artifact.fileName.replace(/"/g, '')}"`,
      );
    }
    stream.on('error', (error) => {
      if (!res.headersSent) {
        const normalized = normalizeError(error);
        res.statusCode = statusCodeForNormalizedError(normalized.code);
        res.end(normalized.message);
      } else {
        res.destroy(error as Error);
      }
    });
    res.on('close', () => {
      if (res.writableFinished) {
        cleanupDownloadableArtifact(artifactId);
      }
    });
    stream.pipe(res);
  } catch (error) {
    const normalized = normalizeError(error);
    sendRestJsonError(res, normalized);
  }
}

async function abortInFlightIosRunnerSessionsWhileDisconnected(
  requestId: string | undefined,
): Promise<void> {
  try {
    const deadline = Date.now() + CLIENT_DISCONNECT_ABORT_MAX_WINDOW_MS;
    while (isRequestCanceled(requestId) && Date.now() < deadline) {
      const { abortAllIosRunnerSessions } = await import('../platforms/ios/runner-client.ts');
      await abortAllIosRunnerSessions();
      if (!isRequestCanceled(requestId)) break;
      await sleep(CLIENT_DISCONNECT_ABORT_POLL_INTERVAL_MS);
    }
  } catch (error) {
    emitDiagnostic({
      level: 'error',
      phase: 'request_client_disconnect_abort_failed',
      data: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function shouldAbortIosRunnerSessionsOnDisconnect(req: DaemonRequest): boolean {
  if (req.flags?.platform === 'android') return false;
  if (req.flags?.platform === 'ios') return true;
  return IOS_RUNNER_ABORT_REPLAY_COMMANDS.has(req.command);
}

async function authorizeAuxiliaryHttpRequest(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  authHook: HttpAuthHook | null;
  expectedToken?: string;
  daemonRequest: Pick<DaemonRequest, 'command' | 'positionals'>;
}): Promise<{ tenantId?: string } | null> {
  const { req, res, authHook, expectedToken, daemonRequest } = params;
  const token = resolveToken({}, req.headers);
  const tokenError = enforceDaemonToken(token, expectedToken);
  if (tokenError) {
    sendRestJsonError(res, tokenError);
    return null;
  }

  const syntheticRpc: JsonRpcRequest = {
    jsonrpc: '2.0',
    id: null,
    method: 'agent_device.command',
  };
  const authResult = await runHttpAuthHook(authHook, {
    headers: req.headers,
    rpcRequest: syntheticRpc,
    daemonRequest: {
      token,
      session: 'default',
      command: daemonRequest.command,
      positionals: daemonRequest.positionals,
    },
  });
  if (!authResult.ok) {
    res.statusCode = authResult.statusCode;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        ok: false,
        error:
          authResult.response.error?.data?.message ??
          authResult.response.error?.message ??
          'Unauthorized',
      }),
    );
    return null;
  }

  return { tenantId: authResult.tenantId };
}

function sendRestJsonError(
  res: http.ServerResponse,
  normalized: ReturnType<typeof normalizeError>,
): void {
  res.statusCode = statusCodeForNormalizedError(normalized.code);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: false, error: normalized.message, code: normalized.code }));
}

function enforceDaemonToken(
  requestToken: string,
  expectedToken: string | undefined,
): ReturnType<typeof normalizeError> | null {
  if (!expectedToken) return null;
  if (timingSafeStringEqual(requestToken, expectedToken)) return null;
  return normalizeError(new AppError('UNAUTHORIZED', 'Invalid token'));
}
