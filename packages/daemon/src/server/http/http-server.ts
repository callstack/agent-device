// The daemon's HTTP listener: what the socket answers when a request arrives.
// `/health`, the auxiliary route dispatch (host admin, upload, artifacts,
// request diagnostics), and the `/rpc` flow live here as one named unit per
// question the flow asks: envelope validation, request admission, the
// request's cancellation lifetime, and invocation. The envelope framing lives
// in `http-rpc-envelope.ts`, the authorization decisions in
// `http-authorization.ts`, and the RPC method vocabulary in `http-rpc-methods.ts`.
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { AsyncResource } from 'node:async_hooks';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { DiagnosticsRecordRef, NormalizedError } from '@agent-device/kernel/errors';
import { normalizeError } from '@agent-device/kernel/errors';
import { LEASE_BACKENDS } from '@agent-device/kernel/contracts';
import { isRecord } from '@agent-device/kernel/record';
import type { DaemonInvokeFn, DaemonRequest } from '../../core/daemon-request.ts';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
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
import { shouldStreamRequestProgress } from '@agent-device/daemon-contracts/request-progress-protocol';
import { statusCodeForNormalizedError } from '../http-errors.ts';
import { tryHandleUploadHttpRoute } from '../upload-http.ts';
import { tryHandleDownloadableArtifactHttpRoute } from '../downloadable-artifact-http.ts';
import { tryHandleRequestDiagnosticsHttpRoute } from '../request-diagnostics-http.ts';
import { tryHandleHostAdminHttpRoute } from '../host-lease-http.ts';
import type { LeaseRegistry } from '../../resources/lease-registry.ts';
import {
  authorizeAuxiliaryHttpRequest,
  authorizeDiagnosticsHttpRequest,
  enforceDaemonToken,
  loadHttpAuthHook,
  restrictRemoteHttpRequest,
  resolveToken,
  runHttpAuthHook,
  type HttpAuthHook,
} from './http-authorization.ts';
import {
  createRpcError,
  jsonRpcCodeForNormalizedError,
  sendJson,
  writeProgressEnvelope,
  writeRpcResponseEnvelope,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './http-rpc-envelope.ts';
import {
  isCommandRpcMethod,
  methodToDaemonRequest,
  SUPPORTED_RPC_METHODS,
} from './http-rpc-methods.ts';
import {
  resolveTrustedTenant,
  tenantTrustRejectionError,
  type TenantTrustDecision,
} from './tenant-trust.ts';
import { refuseStaleDaemonInstance } from './http-instance-precondition.ts';

const MAX_HTTP_RPC_BODY_BYTES = 1024 * 1024;

export async function createDaemonHttpServer(options: {
  handleRequest: DaemonInvokeFn;
  leaseRegistry?: LeaseRegistry;
  endSessionsForLease?: (leaseId: string) => Promise<void>;
  token?: string;
  retainArtifacts?: boolean;
  /** The runtime host's environment: read for the auth hook and handed to the download archive. */
  env: NodeJS.ProcessEnv;
  /** The runtime host's working directory, the base for resolving the auth hook module. */
  cwd: string;
  /**
   * Resolves a request diagnostics record path for the `/sessions/.../requests/...`
   * route (#1801). Omitted by embedded servers with no session store; the route
   * then does not exist and a remote caller is told the record is unavailable
   * rather than handed a daemon-host path.
   */
  resolveRequestDiagnosticsPath?: (ref: DiagnosticsRecordRef) => string;
  /**
   * Hears about a `/rpc` flow rejection this server answered itself, because no part of the flow
   * reached the answer. The daemon-level sinks live in the runtime, outside any request, so the
   * runtime injects them; an embedded server with no log and no stderr of its own omits this and
   * still refuses the call.
   */
  onUnownedRequestFailure?: (failure: NormalizedError) => void;
}): Promise<http.Server> {
  const instanceId = randomUUID();
  const hostArch = await readHostCpuArch();
  const leaseBackends = LEASE_BACKENDS.filter(
    (backend) => backend !== 'macos-app' || process.platform === 'darwin',
  );
  const environment = options.env;
  const authHook = await loadHttpAuthHook(environment, options.cwd);
  const {
    handleRequest,
    token,
    retainArtifacts = false,
    resolveRequestDiagnosticsPath,
    onUnownedRequestFailure,
  } = options;
  const onRequest = AsyncResource.bind((req: http.IncomingMessage, res: http.ServerResponse) => {
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
        endSessionsForLease: options.endSessionsForLease,
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
        hostEnv: environment,
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

    readRpcRequestBody(req, res, (body) => {
      // The flow owns this request's lifetime, so this call site must neither hold lifetime state
      // nor re-run it; the `catch` reports the failure to the daemon-level sink and answers. That
      // answer is load-bearing: the daemon exits on an `unhandledRejection`, so a rejection dropped
      // here would let any process that reaches the port stop the daemon with one request body.
      void handleRpcRequest({
        req,
        res,
        body,
        authHook,
        expectedToken: token,
        instanceId,
        handleRequest,
      }).catch((error: unknown) => {
        sendUnownedRpcRequestFailure(res, onUnownedRequestFailure, error);
      });
    });
  });
  return http.createServer(onRequest);
}

/** Accumulates one `/rpc` body and hands it to the flow once the stream ends. */
function readRpcRequestBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  onBody: (body: string) => void,
): void {
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
      sendRpcRefusal(res, rpcParseErrorRefusal());
    }
  });

  req.on(
    'end',
    AsyncResource.bind(() => {
      onBody(body);
    }),
  );
}

// The `/rpc` flow, in the order it runs: the envelope decides whether this body is a
// call at all; admission decides whether its caller may run it; the lifetime owns the
// tracking id and cancellation from that moment to cleanup; invocation runs the
// request and answers, ending the lifetime.

/** One `/rpc` call: validate the envelope, admit the request, run it, answer for it. */
async function handleRpcRequest(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  body: string;
  authHook: HttpAuthHook | null;
  expectedToken: string | undefined;
  instanceId: string;
  handleRequest: DaemonInvokeFn;
}): Promise<void> {
  const { req, res, body, authHook, expectedToken, instanceId, handleRequest } = params;
  const validated = validateRpcRequestEnvelope(body);
  if (!validated.ok) {
    sendRpcRefusal(res, validated.refusal);
    return;
  }

  const lifetime = beginRpcRequestLifetime({ req, res, rpcId: validated.rpcRequest.id });
  // The `finally` below is the flow's only cleanup for a call that never reached an
  // invocation: unsound method params or a duplicate tracking id. An invoked request
  // releases its own lifetime as the last step of answering, before anything observing the
  // socket gets a turn.
  try {
    const admission = await admitRpcRequest({
      req,
      res,
      authHook,
      expectedToken,
      instanceId,
      rpcRequest: validated.rpcRequest,
      method: validated.method,
      params: validated.params,
      lifetime,
    });
    if (admission.outcome !== 'admitted') {
      if (admission.outcome === 'rejected') {
        sendRpcRefusal(res, admission.refusal);
      }
      return;
    }

    lifetime.watchForClientDisconnect();
    await invokeAdmittedRpcRequest({
      res,
      rpcRequest: validated.rpcRequest,
      daemonRequest: admission.daemonRequest,
      handleRequest,
      lifetime,
    });
  } catch (error) {
    // Reached only when the call never got as far as an invocation: unsound method params
    // or a duplicate tracking id. The failure answer is on its way, so a socket closing
    // after it is not a client walking out on work still in flight.
    lifetime.markHandlerCompleted();
    sendRpcRequestFailure(res, validated.rpcRequest.id, normalizeError(error));
  } finally {
    lifetime.release();
  }
}

// Is this POST body a JSON-RPC call this daemon answers? Only the envelope's own
// soundness is decided here: which methods exist and how their params become a
// `DaemonRequest` belongs to `http-rpc-methods.ts`, and whether the caller may run
// it belongs to the admission gate below.

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/** One way to refuse a `/rpc` call: the envelope to answer with and the status its code prescribes. */
type RpcRefusal = {
  response: JsonRpcResponse;
  statusCode: number;
};

/** The envelope's verdict on one `/rpc` body, before anyone asks whether it may run. */
type RpcEnvelopeVerdict =
  | {
      ok: true;
      rpcRequest: JsonRpcRequest;
      /** The method named by a sound envelope, which the method vocabulary recognizes. */
      method: string;
      params: Record<string, unknown>;
    }
  | { ok: false; refusal: RpcRefusal };

/**
 * Parses and validates one `/rpc` body. A body that is not JSON gets the same -32700 answer
 * the socket's `error` listener gives a stream that breaks before it ends. A body that parses as
 * anything but one object — `null`, a number, a string, an array — is refused as -32600 before
 * anything reads a property off it: reading through `null` throws, and that throw has no call to
 * answer for.
 */
function validateRpcRequestEnvelope(body: string): RpcEnvelopeVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, refusal: rpcParseErrorRefusal() };
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      refusal: rpcRefusal(null, INVALID_REQUEST, 'Invalid Request', 400),
    };
  }
  const rpcRequest = parsed as JsonRpcRequest;

  const refused = (code: number, message: string, statusCode: number): RpcEnvelopeVerdict => ({
    ok: false,
    refusal: rpcRefusal(rpcRequest.id ?? null, code, message, statusCode),
  });

  if (rpcRequest.jsonrpc !== '2.0' || typeof rpcRequest.method !== 'string') {
    return refused(INVALID_REQUEST, 'Invalid Request', 400);
  }
  if (!SUPPORTED_RPC_METHODS.has(rpcRequest.method)) {
    return refused(METHOD_NOT_FOUND, `Method not found: ${rpcRequest.method}`, 404);
  }
  if (!rpcRequest.params || typeof rpcRequest.params !== 'object') {
    return refused(INVALID_PARAMS, 'Invalid params', 400);
  }
  return {
    ok: true,
    rpcRequest,
    method: rpcRequest.method,
    params: rpcRequest.params as Record<string, unknown>,
  };
}

/** The -32700 answer for a body that never parsed: a truncated stream, or one that was
 * never JSON at all. */
function rpcParseErrorRefusal(): RpcRefusal {
  return rpcRefusal(null, PARSE_ERROR, 'Parse error', 400);
}

/** Frames a refusal for the call named by `requestId`; `data` becomes the envelope's `data`. */
function rpcRefusal(
  requestId: JsonRpcRequest['id'],
  code: number,
  message: string,
  statusCode: number,
  data?: Record<string, unknown>,
): RpcRefusal {
  return {
    response: createRpcError(requestId ?? null, code, message, data),
    statusCode,
  };
}

/** Puts a refusal on the wire with the status it carries. */
function sendRpcRefusal(res: http.ServerResponse, refusal: RpcRefusal): void {
  sendJson(res, refusal.response, refusal.statusCode);
}

// What happens to one RPC request's cancellation state between admission and cleanup? The
// tracking id, the request-scoped AbortSignal registration, the client-disconnect watch, and
// the release that ends them live together below.

/**
 * One RPC request's cancellation lifetime: opened when its envelope is sound, watched until the
 * handler answers, released once the answer is on the wire. `release` is idempotent and safe
 * before `admit`, so a call that was never admitted still cleans up from one place.
 */
type RpcRequestLifetime = {
  /**
   * Stamps the daemon's request tracking id into `meta` and registers the request's AbortSignal
   * under it. An id already in flight throws `duplicate_request_id` from here, so the caller
   * that loses the race never reaches the auth gate with it.
   */
  admit(daemonRequest: DaemonRequest): DaemonRequest;
  /**
   * Watches for the client vanishing while its handler is still working, and marks the request
   * canceled when it does. Once `markHandlerCompleted` has run, a closing response is a finished
   * answer rather than a walked-out client, so nothing is marked.
   */
  watchForClientDisconnect(): void;
  /**
   * Ends the window in which a closing response means "the client left" rather than "the answer
   * finished". The invocation calls it the moment the handler returns, before the answer is
   * written, so a disconnect during the final write is not a cancellation.
   */
  markHandlerCompleted(): void;
  /** Ends the registration. Safe to call more than once, and before `admit`. */
  release(): void;
};

function beginRpcRequestLifetime(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  /** The RPC call id, the fallback seed when the request carries no tracking id. */
  rpcId: unknown;
}): RpcRequestLifetime {
  const { req, res, rpcId } = params;
  let requestId: string | undefined;
  let abortRegistration: ReturnType<typeof registerRequestAbort>;
  let handlerCompleted = false;
  let canceledInFlight = false;

  // `res` close fires for a finished response too, so the completion guard is what separates a
  // real disconnect from an ordinary end. `markRequestCanceled` aborts only this request's
  // signal, leaving other requests, other devices, and non-Apple work alone.
  const markCanceledIfResponseIncomplete = () => {
    if (handlerCompleted || res.writableFinished || canceledInFlight) return;
    canceledInFlight = true;
    markRequestCanceled(requestId);
    emitDiagnostic({
      level: 'warn',
      phase: 'request_client_disconnected',
      data: {
        requestId,
      },
    });
  };

  return {
    admit(daemonRequest) {
      requestId = resolveRequestTrackingId(daemonRequest.meta?.requestId, rpcId);
      abortRegistration = registerRequestAbort(requestId);
      return {
        ...daemonRequest,
        meta: { ...daemonRequest.meta, requestId },
      };
    },
    watchForClientDisconnect() {
      const onClientGone = AsyncResource.bind(markCanceledIfResponseIncomplete);
      req.on('aborted', onClientGone);
      res.on('close', onClientGone);
      if (req.aborted || res.destroyed) {
        markCanceledIfResponseIncomplete();
      }
    },
    markHandlerCompleted() {
      handlerCompleted = true;
    },
    release() {
      clearRequestAbortRegistration(abortRegistration);
    },
  };
}

// May the caller of a validated RPC call run this command, and as which tenant, with which
// surfaces available? The individual decisions belong to `http-authorization.ts`,
// `tenant-trust.ts`, and `http-instance-precondition.ts`; the gate below owns the ORDER `/rpc`
// asks them in. That order is the security contract: an unattested tenant is refused before the
// token is compared, and a stale daemon instance after it.

/**
 * The gate's answer for one validated call. `answered` is the stale-daemon-instance refusal,
 * which writes its own 409 and mismatch header: nothing else may be written for the call.
 */
type RpcRequestAdmission =
  | { outcome: 'admitted'; daemonRequest: DaemonRequest }
  | { outcome: 'rejected'; refusal: RpcRefusal }
  | { outcome: 'answered' };

/**
 * Turns a validated call into a request its caller may run. The tracking-id registration runs
 * ahead of the gates on purpose, so a request id already in flight is refused as
 * `duplicate_request_id` before the operator's hook sees the call. Malformed wire input throws
 * (`methodToDaemonRequest` validates params as INVALID_ARGS) and never reaches the gates.
 */
async function admitRpcRequest(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  authHook: HttpAuthHook | null;
  expectedToken: string | undefined;
  instanceId: string;
  rpcRequest: JsonRpcRequest;
  /** The validated envelope's method, which the vocabulary recognizes. */
  method: string;
  params: Record<string, unknown>;
  lifetime: RpcRequestLifetime;
}): Promise<RpcRequestAdmission> {
  const { req, res, authHook, expectedToken, instanceId, rpcRequest, method, lifetime } = params;
  const wireRequest = methodToDaemonRequest(method, params.params, req.headers);
  // A command call naming no command is params the router cannot route.
  if (namesNoCommand(method, wireRequest)) {
    return {
      outcome: 'rejected',
      refusal: rpcRefusal(
        rpcRequest.id ?? null,
        INVALID_PARAMS,
        'Invalid params: command is required',
        400,
      ),
    };
  }
  const daemonRequest = lifetime.admit(wireRequest);

  // Captured before the hook runs: what the caller claimed is an input to the trust
  // decision, never an identity.
  const clientDeclaredTenant = daemonRequest.meta?.tenantId ?? daemonRequest.flags?.tenant;

  const authResult = await runHttpAuthHook(authHook, {
    headers: req.headers,
    rpcRequest,
    daemonRequest,
  });
  if (!authResult.ok) {
    return {
      outcome: 'rejected',
      refusal: { response: authResult.response, statusCode: authResult.statusCode },
    };
  }
  const tenantTrust = resolveTrustedTenant({
    hookConfigured: authHook !== null,
    hookAttestedTenant: authResult.tenantId,
    clientDeclaredTenant,
  });
  if (!tenantTrust.trusted) {
    return refused(rpcRequest, -32001, tenantTrustRejectionError(), 401);
  }
  const tokenError = enforceDaemonToken(daemonRequest.token, expectedToken);
  if (tokenError) {
    return refused(rpcRequest, -32000, tokenError, 401);
  }
  if (refuseStaleDaemonInstance(req, res, rpcRequest.id ?? null, instanceId)) {
    return { outcome: 'answered' };
  }

  return {
    outcome: 'admitted',
    daemonRequest: stampAdmittedIdentity(daemonRequest, tenantTrust, authHook, req),
  };
}

/** Only a command call has to name a command; other methods carry their own params. */
function namesNoCommand(method: string, daemonRequest: DaemonRequest): boolean {
  return (
    isCommandRpcMethod(method) &&
    !(typeof daemonRequest.command === 'string' && daemonRequest.command.length > 0)
  );
}

/** Refuses the call; `error` answers as the envelope's `data`, carrying its code and hints. */
function refused(
  rpcRequest: JsonRpcRequest,
  code: number,
  error: NormalizedError,
  statusCode: number,
): RpcRequestAdmission {
  return {
    outcome: 'rejected',
    refusal: rpcRefusal(rpcRequest.id ?? null, code, error.message, statusCode, error),
  };
}

/**
 * Rewrites the identity and scope carriers an admitted request may not choose for
 * itself: the trusted tenant, the isolation attestation implies, and the surfaces the
 * remote HTTP surface withholds.
 */
function stampAdmittedIdentity(
  daemonRequest: DaemonRequest,
  tenantTrust: Extract<TenantTrustDecision, { trusted: true }>,
  authHook: HttpAuthHook | null,
  req: http.IncomingMessage,
): DaemonRequest {
  let admitted: DaemonRequest = {
    ...daemonRequest,
    meta: {
      ...daemonRequest.meta,
      tenantId: tenantTrust.tenantId,
      // Only an attested tenant forces isolation, and the client gets no say in it: a
      // client-named namespace is one another tenant can name too. The diagnostics route
      // reads the same distinction back out of `authorizeAuxiliaryHttpRequest`.
      sessionIsolation: tenantTrust.attested ? 'tenant' : daemonRequest.meta?.sessionIsolation,
    },
  };
  if (admitted.flags?.tenant !== undefined) {
    admitted = { ...admitted, flags: { ...admitted.flags, tenant: tenantTrust.tenantId } };
  }
  // Consumers reading the flag rather than the meta (`session-doctor-options.ts`) must not
  // see the isolation the meta just overrode.
  if (tenantTrust.attested && admitted.flags?.sessionIsolation !== undefined) {
    admitted = { ...admitted, flags: { ...admitted.flags, sessionIsolation: 'tenant' } };
  }
  return restrictRemoteHttpRequest(
    admitted,
    authHook !== null,
    req.headers[DAEMON_HTTP_NETWORK_ACCESS_HEADER],
  );
}

// How is an admitted request run, and how does its answer reach the client — as one JSON body,
// or as a stream that opens before the work finishes? `shouldStreamRequestProgress` decides
// which, and `http-rpc-envelope.ts` owns the framing either way. Running and answering stay one
// step because the lifetime is released the moment its answer is on the wire, in the same turn
// the handler resolves: writing an answer is never a disconnect, and the tracking id is free
// again before anything observing the socket gets a turn.

/**
 * Runs an admitted request and answers for it, ending its lifetime. A request that asked to
 * stream progress gets its headers before the handler starts, so events reach the client while
 * the work is still happening; any other request gets one JSON body whose HTTP status its
 * normalized error chooses. A handler that throws is answered here rather than re-thrown: once a
 * stream's headers are out, the envelope inside the stream is the only way left to report it.
 */
async function invokeAdmittedRpcRequest(params: {
  res: http.ServerResponse;
  rpcRequest: JsonRpcRequest;
  daemonRequest: DaemonRequest;
  handleRequest: DaemonInvokeFn;
  lifetime: RpcRequestLifetime;
}): Promise<void> {
  const { res, rpcRequest, daemonRequest, handleRequest, lifetime } = params;
  try {
    if (!shouldStreamRequestProgress(daemonRequest)) {
      const daemonResponse = await handleRequest(daemonRequest);
      lifetime.markHandlerCompleted();
      sendJson(res, rpcAnswerFor(rpcRequest, daemonResponse), plainAnswerStatus(daemonResponse));
      return;
    }

    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson');
    const daemonResponse = await withRequestProgressSink(
      (event) => writeProgressEnvelope(res, event),
      async () => await handleRequest(daemonRequest),
    );
    lifetime.markHandlerCompleted();
    writeRpcResponseEnvelope(res, rpcAnswerFor(rpcRequest, daemonResponse));
  } catch (error) {
    lifetime.markHandlerCompleted();
    sendRpcRequestFailure(res, rpcRequest.id, normalizeError(error));
  } finally {
    lifetime.release();
  }
}

/**
 * Last-resort answer for a `/rpc` flow rejection: no call id is trusted, so the refusal carries
 * none. `reportFailure` is the daemon-level sink the server was constructed with — the one place
 * these events have a stderr and a log to reach — and it runs before the answer, because a sink is
 * the caller's code and a sink that cannot take the event must not cost the client its answer.
 */
function sendUnownedRpcRequestFailure(
  res: http.ServerResponse,
  reportFailure: ((failure: NormalizedError) => void) | undefined,
  error: unknown,
): void {
  const failure = normalizedRpcFlowFailure(error);
  try {
    if (reportFailure) reportFailure(failure);
  } catch {
    // A closed stderr throws on write. The answer below is the reason this branch exists.
  }
  if (res.writableEnded) return;
  sendRpcRequestFailure(res, null, failure);
}

/**
 * Normalizes a flow rejection for the last-resort answer. Both of the flow's own catches normalize
 * the reason *while evaluating* their answer, so a reason that cannot be read — a `details` getter
 * that throws reaches `redactDiagnosticData`'s property walk — throws again inside that catch and
 * lands here instead, still unreadable. Such a reason gets the same unknown-error failure
 * `normalizeError` gives nothing; the answer and the record must not depend on reading it.
 */
function normalizedRpcFlowFailure(error: unknown): NormalizedError {
  try {
    return normalizeError(error);
  } catch {
    return normalizeError(undefined);
  }
}

/**
 * Answers a call that failed before an answer could be written — malformed wire input the method
 * vocabulary refused, a handler that threw, or a flow that rejected outright. A status code goes
 * only to a call that has not started answering; a stream already opened answers with its envelope.
 */
function sendRpcRequestFailure(
  res: http.ServerResponse,
  requestId: JsonRpcRequest['id'],
  failure: NormalizedError,
): void {
  const response = createRpcError(
    requestId ?? null,
    jsonRpcCodeForNormalizedError(failure.code),
    failure.message,
    failure,
  );
  if (res.headersSent) {
    writeRpcResponseEnvelope(res, response);
    return;
  }
  sendJson(res, response, statusCodeForNormalizedError(failure));
}

function rpcAnswerFor(rpcRequest: JsonRpcRequest, daemonResponse: DaemonResponse): JsonRpcResponse {
  if (daemonResponse.ok) {
    return { jsonrpc: '2.0', id: rpcRequest.id ?? null, result: daemonResponse };
  }
  return createRpcError(
    rpcRequest.id ?? null,
    -32000,
    daemonResponse.error.message,
    daemonResponse.error,
  );
}

// A successful plain answer has no status to choose; 200 is `sendJson`'s own default.
function plainAnswerStatus(daemonResponse: DaemonResponse): number {
  return daemonResponse.ok ? 200 : statusCodeForNormalizedError(daemonResponse.error);
}
