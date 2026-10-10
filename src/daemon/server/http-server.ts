// The daemon's HTTP listener: what the socket answers when a request arrives.
// `/health`, the auxiliary route dispatch (host admin, upload, artifacts,
// request diagnostics), the `/rpc` body framing, and the wiring of the
// auth-hook/tenant/token gate around each request live here. The envelope
// framing lives in `http-rpc-envelope.ts`, the authorization decisions in
// `http-authorization.ts`, and the RPC method vocabulary in
// `http-rpc-methods.ts`.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { normalizeError, type DiagnosticsRecordRef } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { LEASE_BACKENDS } from '@agent-device/kernel/contracts';
import type { DaemonInvokeFn } from '../daemon-request.ts';
import {
  clearRequestAbortRegistration,
  markRequestCanceled,
  registerRequestAbort,
  resolveRequestTrackingId,
  withRequestProgressSink,
} from '@agent-device/host-kit/request';
import {
  buildDaemonHealthPayload,
  DAEMON_HTTP_NETWORK_ACCESS_HEADER,
} from '@agent-device/contracts/daemon-http';
import { readVersion } from '@agent-device/host-kit/version';
import { readHostCpuArch } from '@agent-device/host-kit/process';
import { statusCodeForNormalizedError } from '../http-errors.ts';
import { tryHandleUploadHttpRoute } from '../upload-http.ts';
import { tryHandleDownloadableArtifactHttpRoute } from '../downloadable-artifact-http.ts';
import { tryHandleRequestDiagnosticsHttpRoute } from '../request-diagnostics-http.ts';
import { tryHandleHostAdminHttpRoute } from '../host-lease-http.ts';
import { resolveTrustedTenant, tenantTrustRejectionError } from './tenant-trust.ts';
import { refuseStaleDaemonInstance } from './http-instance-precondition.ts';
import type { LeaseRegistry } from '../lease-registry.ts';
import { shouldStreamRequestProgress } from '../../request-progress-protocol.ts';
import {
  createRpcError,
  jsonRpcCodeForNormalizedError,
  sendJson,
  statusCodeForDaemonError,
  writeProgressEnvelope,
  writeRpcResponseEnvelope,
} from './http-rpc-envelope.ts';
import type { JsonRpcRequest, JsonRpcResponse } from './http-rpc-envelope.ts';
import {
  authorizeAuxiliaryHttpRequest,
  authorizeDiagnosticsHttpRequest,
  enforceDaemonToken,
  loadHttpAuthHook,
  resolveToken,
  restrictRemoteHttpRequest,
  runHttpAuthHook,
} from './http-authorization.ts';
import {
  isCommandRpcMethod,
  methodToDaemonRequest,
  SUPPORTED_RPC_METHODS,
} from './http-rpc-methods.ts';

const MAX_HTTP_RPC_BODY_BYTES = 1024 * 1024;

export async function createDaemonHttpServer(options: {
  handleRequest: DaemonInvokeFn;
  leaseRegistry?: LeaseRegistry;
  token?: string;
  retainArtifacts?: boolean;
  env?: NodeJS.ProcessEnv;
  /**
   * Resolves a request diagnostics record path for the `/sessions/.../requests/...`
   * route (#1801). Omitted by embedded servers with no session store; the route
   * then does not exist and a remote caller is told the record is unavailable
   * rather than handed a daemon-host path.
   */
  resolveRequestDiagnosticsPath?: (ref: DiagnosticsRecordRef) => string;
}): Promise<http.Server> {
  const instanceId = randomUUID();
  const hostArch = await readHostCpuArch();
  const leaseBackends = LEASE_BACKENDS.filter(
    (backend) => backend !== 'macos-app' || process.platform === 'darwin',
  );
  const environment = options.env ?? process.env;
  const authHook = await loadHttpAuthHook(environment);
  const { handleRequest, token, retainArtifacts = false, resolveRequestDiagnosticsPath } = options;
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          buildDaemonHealthPayload('agent-device-daemon', readVersion(), {
            instanceId,
            hostArch,
            leaseBackends,
          }),
        ),
      );
      return;
    }

    if (
      token &&
      options.leaseRegistry &&
      tryHandleHostAdminHttpRoute({
        req,
        res,
        expectedToken: token,
        registry: options.leaseRegistry,
      })
    ) {
      return;
    }

    if (
      tryHandleUploadHttpRoute({
        req,
        res,
        token: resolveToken({}, req.headers),
        authorize: async (request) =>
          await authorizeAuxiliaryHttpRequest({
            req: request.req,
            res: request.res,
            authHook,
            expectedToken: token,
            daemonRequest: request.daemonRequest,
          }),
      })
    ) {
      return;
    }

    if (
      tryHandleDownloadableArtifactHttpRoute({
        req,
        res,
        retainArtifacts,
        authorize: async (request) =>
          await authorizeAuxiliaryHttpRequest({
            req: request.req,
            res: request.res,
            authHook,
            expectedToken: token,
            daemonRequest: request.daemonRequest,
          }),
      })
    ) {
      return;
    }

    if (
      resolveRequestDiagnosticsPath &&
      tryHandleRequestDiagnosticsHttpRoute({
        req,
        res,
        resolveRecordPath: resolveRequestDiagnosticsPath,
        authorize: async (request) =>
          await authorizeDiagnosticsHttpRequest({
            ...request,
            authHook,
            expectedToken: token,
            leaseRegistry: options.leaseRegistry,
          }),
      })
    ) {
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
      let requestAbortRegistration: ReturnType<typeof registerRequestAbort>;
      let handlerCompleted = false;
      try {
        const params = rpcRequest.params as Record<string, unknown>;
        let daemonRequest = methodToDaemonRequest(rpcRequest.method, params, req.headers);
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
        requestAbortRegistration = registerRequestAbort(requestIdForCleanup);
        const clientDeclaredTenant = daemonRequest.meta?.tenantId ?? daemonRequest.flags?.tenant;

        const authResult = await runHttpAuthHook(authHook, {
          headers: req.headers,
          rpcRequest,
          daemonRequest,
        });
        if (!authResult.ok) {
          sendJson(res, authResult.response, authResult.statusCode);
          return;
        }
        const tenantTrust = resolveTrustedTenant({
          hookConfigured: authHook !== null,
          hookAttestedTenant: authResult.tenantId,
          clientDeclaredTenant,
        });
        if (!tenantTrust.trusted) {
          const normalized = tenantTrustRejectionError();
          sendJson(
            res,
            createRpcError(rpcRequest.id ?? null, -32001, normalized.message, normalized),
            401,
          );
          return;
        }
        const tokenError = enforceDaemonToken(daemonRequest.token, token);
        if (tokenError) {
          sendJson(
            res,
            createRpcError(rpcRequest.id ?? null, -32000, tokenError.message, tokenError),
            401,
          );
          return;
        }
        if (refuseStaleDaemonInstance(req, res, rpcRequest.id ?? null, instanceId)) return;
        daemonRequest.meta = {
          ...daemonRequest.meta,
          tenantId: tenantTrust.tenantId,
          // Attestation is what partitions the session namespace: only an attested
          // tenant gets tenant isolation, so only then does `scopeRequestSession`
          // name the session `<tenant>:...`. The diagnostics route reads the same
          // distinction back out of `authorizeAuxiliaryHttpRequest`.
          //
          // When the hook attested the tenant, isolation is the SERVER's answer and
          // the request does not get a say: honoring a client-supplied `'none'` here
          // dropped the prefix and dropped the caller into the `cwd:<hash>:` namespace
          // instead, which the client names and another tenant can name too.
          sessionIsolation: tenantTrust.attested ? 'tenant' : daemonRequest.meta?.sessionIsolation,
        };
        if (daemonRequest.flags?.tenant !== undefined) {
          daemonRequest.flags = { ...daemonRequest.flags, tenant: tenantTrust.tenantId };
        }
        // Consumers that read the flag rather than the meta (`session-doctor-options.ts`)
        // must not see the isolation the meta just overrode.
        if (tenantTrust.attested && daemonRequest.flags?.sessionIsolation !== undefined) {
          daemonRequest.flags = { ...daemonRequest.flags, sessionIsolation: 'tenant' };
        }
        daemonRequest = restrictRemoteHttpRequest(
          daemonRequest,
          authHook !== null,
          req.headers[DAEMON_HTTP_NETWORK_ACCESS_HEADER],
        );

        let canceledInFlight = false;
        // Request-scoped cancellation: mark this request canceled whenever its client
        // vanishes before the response finishes, regardless of whether headers were
        // already sent. `markRequestCanceled` aborts only this request's AbortSignal,
        // so in-flight runner work owned by the request is canceled without touching
        // other requests, other devices, or non-Apple work. The guard below keys off
        // the response's own completion state, so a normal end is never misclassified
        // as a disconnect.
        const markCanceledIfResponseIncomplete = () => {
          if (handlerCompleted || res.writableFinished || canceledInFlight) return;
          canceledInFlight = true;
          markRequestCanceled(requestIdForCleanup);
          emitDiagnostic({
            level: 'warn',
            phase: 'request_client_disconnected',
            data: {
              requestId: requestIdForCleanup,
            },
          });
        };
        req.on('aborted', markCanceledIfResponseIncomplete);
        // `res` close fires for both pre-header and post-header disconnects; the
        // completion guard distinguishes a real disconnect from a finished response.
        res.on('close', markCanceledIfResponseIncomplete);
        if (req.aborted || res.destroyed) {
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
          statusCodeForDaemonError(daemonResponse.error),
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
        clearRequestAbortRegistration(requestAbortRegistration);
      }
    });
  });
}
