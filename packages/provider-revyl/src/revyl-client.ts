import { AppError, type AppErrorCode } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  RevylDeviceSessionStopResponse,
  RevylStartDeviceRequest,
  RevylStartDeviceResponse,
  RevylWorkerActionResponse,
  RevylWorkerConnection,
  RevylWorkerHealth,
  RevylWorkflowCancelResponse,
  RevylWorkflowLifecycleResponse,
} from './revyl-types.ts';

export const REVYL_DEFAULT_BACKEND_URL = 'https://backend.revyl.ai';

/** Sent on every request so Revyl can attribute the sessions this runtime starts. */
const REVYL_CLIENT_HEADER = 'agent-device';
/** Sent on every device-proxy action; Revyl attributes the action to the driver behind it. */
const REVYL_AGENT_HEADER = 'agent-device';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** How long `start_device` may take to answer: Revyl assigns a worker and boots the device in it. */
export const REVYL_START_DEVICE_TIMEOUT_MS = 120_000;
const RETRY_DELAYS_MS = [500, 1_500] as const;

/** Device-proxy actions Revyl answers to a GET; every other action is a POST. */
const DEVICE_PROXY_GET_ACTIONS = new Set(['screenshot', 'health', 'device_info', 'hierarchy']);

export type RevylClientOptions = Readonly<{
  apiKey: string;
  backendUrl?: string;
  clientVersion: string;
  fetch?: typeof fetch;
}>;

/**
 * Which half of the API one request belongs to, which is what a 404 or 410 means. A route that
 * addresses one session or run reports a session Revyl no longer has; a route that starts or
 * authenticates reports a request the backend refused or never routed.
 */
type RevylRoute = 'session' | 'general';

type RevylRequest = Readonly<{
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  timeoutMs?: number;
  /** Defaults to true for GET and false for POST: a side-effecting action is never replayed. */
  retry?: boolean;
  /** A device-proxy action carries the agent header; an execution-API call does not. */
  workerAction?: boolean;
  /** Defaults to `general`, which never reads a 404 or 410 as a gone session. */
  route?: RevylRoute;
  signal?: AbortSignal;
}>;

type RevylResponse = Readonly<{
  status: number;
  contentType: string | undefined;
  body: Uint8Array;
}>;

/** The Revyl execution API: one origin, one bearer token, typed errors for every failure. */
export type RevylClient = Readonly<{
  backendUrl: string;
  startDevice(
    request: RevylStartDeviceRequest,
    signal?: AbortSignal,
  ): Promise<RevylStartDeviceResponse>;
  getWorkerConnection(workflowRunId: string, signal?: AbortSignal): Promise<RevylWorkerConnection>;
  getWorkerHealth(workflowRunId: string, signal?: AbortSignal): Promise<RevylWorkerHealth>;
  getWorkerHierarchy(workflowRunId: string, signal?: AbortSignal): Promise<string>;
  captureWorkerScreenshot(workflowRunId: string, signal?: AbortSignal): Promise<Uint8Array>;
  workerAction(
    workflowRunId: string,
    action: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<RevylWorkerActionResponse>;
  stopDeviceSession(sessionId: string): Promise<RevylDeviceSessionStopResponse>;
  /** The fallback for a session whose start never returned an id: cancel the run itself. */
  cancelDeviceRun(workflowRunId: string): Promise<void>;
  /** Cheap enough to run on every `connect`: it authenticates without starting a device. */
  verifyCredentials(signal?: AbortSignal): Promise<void>;
}>;

export function createRevylClient(options: RevylClientOptions): RevylClient {
  const backendUrl = resolveRevylBackendUrl(options.backendUrl ?? REVYL_DEFAULT_BACKEND_URL);
  const fetchImpl = options.fetch ?? fetch;
  const baseHeaders = {
    Authorization: `Bearer ${options.apiKey}`,
    Accept: 'application/json',
    'User-Agent': `agent-device/${options.clientVersion}`,
    'X-Revyl-Client': REVYL_CLIENT_HEADER,
  };

  async function send(request: RevylRequest): Promise<RevylResponse> {
    const retry = request.retry ?? request.method === 'GET';
    const attempts = retry ? RETRY_DELAYS_MS.length + 1 : 1;
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await sendOnce(backendUrl, fetchImpl, baseHeaders, request);
      if (!isRetryable(outcome) || attempt >= attempts || request.signal?.aborted) {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      }
      await sleep(
        RETRY_DELAYS_MS[attempt - 1] ?? 1_500,
        undefined,
        request.signal === undefined ? {} : { signal: request.signal },
      ).catch(() => undefined);
    }
  }

  /** A successful call whose body is JSON, or the typed error its status names. */
  async function json<T>(request: RevylRequest): Promise<T> {
    const response = await send(request);
    assertSuccess(request, response);
    return parseJson<T>(request, response);
  }

  /** A successful call whose body is raw text or bytes; a binary action still reports errors as JSON. */
  async function body(request: RevylRequest): Promise<Uint8Array> {
    const response = await send(request);
    if (response.status < 200 || response.status >= 300) {
      assertSuccess(request, response);
    }
    return response.body;
  }

  function workerRequest(
    workflowRunId: string,
    action: string,
    signal?: AbortSignal,
  ): RevylRequest {
    return {
      method: DEVICE_PROXY_GET_ACTIONS.has(action) ? 'GET' : 'POST',
      path: `/api/v1/execution/device-proxy/${encodeURIComponent(workflowRunId)}/${action}`,
      workerAction: true,
      route: 'session',
      ...(signal === undefined ? {} : { signal }),
    };
  }

  return Object.freeze({
    backendUrl,
    startDevice(request, signal) {
      return json<RevylStartDeviceResponse>({
        method: 'POST',
        path: '/api/v1/execution/start_device',
        body: request,
        timeoutMs: REVYL_START_DEVICE_TIMEOUT_MS,
        ...(signal === undefined ? {} : { signal }),
      });
    },
    getWorkerConnection(workflowRunId, signal) {
      return json<RevylWorkerConnection>({
        method: 'GET',
        path: `/api/v1/execution/streaming/worker-connection/${encodeURIComponent(workflowRunId)}`,
        // The route names the run, so Revyl's answer that there is no such run is its answer that the
        // session is gone — the same reading `/stop` and `cancel` get.
        route: 'session',
        // The readiness loop is the poller: it owns the beat and the deadline, so it has to see this
        // answer on the first attempt rather than behind a transport replay.
        retry: false,
        ...(signal === undefined ? {} : { signal }),
      });
    },
    getWorkerHealth(workflowRunId, signal) {
      return json<RevylWorkerHealth>({
        ...workerRequest(workflowRunId, 'health', signal),
        // Revyl answers this with 503 until the worker attaches, which is the not-ready the loop below
        // polls on. A transport replay would hide that answer for two seconds per poll.
        retry: false,
      });
    },
    async getWorkerHierarchy(workflowRunId, signal) {
      return new TextDecoder().decode(
        await body(workerRequest(workflowRunId, 'hierarchy', signal)),
      );
    },
    async captureWorkerScreenshot(workflowRunId, signal) {
      return await body(workerRequest(workflowRunId, 'screenshot', signal));
    },
    async workerAction(workflowRunId, action, body, signal) {
      const request = workerRequest(workflowRunId, action, signal);
      const response = await json<RevylWorkerActionResponse>({
        ...request,
        ...(body === undefined ? {} : { body }),
      });
      assertWorkerActionSuccess(request, response);
      return response;
    },
    async stopDeviceSession(sessionId) {
      const response = await json<RevylDeviceSessionStopResponse>({
        method: 'POST',
        path: `/api/v1/execution/device/sessions/${encodeURIComponent(sessionId)}/stop`,
        retry: true,
        route: 'session',
      });
      assertLifecycleAccepted('stop', response);
      return response;
    },
    async cancelDeviceRun(workflowRunId) {
      const response = await json<RevylWorkflowCancelResponse>({
        method: 'POST',
        path: `/api/v1/execution/device/status/cancel/${encodeURIComponent(workflowRunId)}`,
        retry: true,
        route: 'session',
      });
      assertLifecycleAccepted('cancel', response);
    },
    async verifyCredentials(signal) {
      await json<unknown>({
        method: 'GET',
        path: '/api/v1/entity/users/get_user_uuid',
        ...(signal === undefined ? {} : { signal }),
      });
    },
  });
}

async function sendOnce(
  backendUrl: string,
  fetchImpl: typeof fetch,
  baseHeaders: Record<string, string>,
  request: RevylRequest,
): Promise<RevylResponse | Error> {
  const timeout = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  const headers = { ...baseHeaders };
  if (request.workerAction) headers['X-Revyl-Agent'] = REVYL_AGENT_HEADER;
  if (request.body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    const response = await fetchImpl(new URL(request.path, backendUrl), {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      redirect: 'error',
      signal,
    });
    return Object.freeze({
      status: response.status,
      contentType: response.headers.get('content-type') ?? undefined,
      body: new Uint8Array(await response.arrayBuffer()),
    });
  } catch (error) {
    if (request.signal?.aborted) return requestCanceled(request, error);
    if (timeout.aborted) return requestTimedOut(request, error);
    return new AppError(
      'COMMAND_FAILED',
      `Revyl did not answer ${request.method} ${request.path}.`,
      { reason: 'provider-unreachable', path: request.path },
      error,
    );
  }
}

function isRetryable(outcome: RevylResponse | Error): boolean {
  return outcome instanceof Error || revylFailure('general', outcome.status).retryable;
}

function requestCanceled(request: RevylRequest, cause: unknown): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `Revyl request ${request.method} ${request.path} was canceled.`,
    { reason: 'request_canceled', path: request.path },
    cause,
  );
}

function requestTimedOut(request: RevylRequest, cause: unknown): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `Revyl request ${request.method} ${request.path} got no response within ${
      request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    } ms.`,
    {
      reason: 'request_timeout',
      path: request.path,
      hint: 'Revyl may have carried out the request. Check the session before retrying it.',
    },
    cause,
  );
}

/** A non-2xx answer becomes the typed error its status names, with Revyl's own detail attached. */
function assertSuccess(request: RevylRequest, response: RevylResponse): void {
  if (response.status >= 200 && response.status < 300) return;
  const detail = responseDetail(response);
  const failure = revylFailure(request.route ?? 'general', response.status);
  const details: Record<string, unknown> = {
    reason: failure.reason,
    path: request.path,
    providerStatus: response.status,
  };
  if (detail !== undefined) details.providerDetail = detail;
  if (failure.uncertain) {
    details.hint = `Revyl did not confirm ${request.method} ${request.path}; the action may have landed.`;
  }
  throw new AppError(
    failure.code,
    `Revyl request ${request.method} ${request.path} failed with HTTP ${response.status}${
      detail === undefined ? '' : `: ${detail}`
    }`,
    details,
  );
}

/**
 * Revyl's `/stop` and `/status/cancel` answers name the verdict they reached, and a 200 that says
 * `success: false` or `request_accepted: false` is a refusal the caller still has to act on: the
 * session is rented either way.
 */
function assertLifecycleAccepted(
  operation: 'stop' | 'cancel',
  response: RevylWorkflowLifecycleResponse,
): void {
  if (response.success === true && (response.request_accepted ?? true) === true) return;
  const message = typeof response.message === 'string' ? response.message : undefined;
  throw new AppError(
    'COMMAND_FAILED',
    `Revyl did not ${operation === 'stop' ? 'stop the session' : 'cancel the run'}${
      message === undefined ? '' : `: ${message}`
    }`,
    {
      reason: 'provider-refused',
      operation,
      ...(message === undefined ? {} : { providerDetail: message }),
      hint: 'The Revyl session may still be rented. End it from Revyl if it stays listed.',
    },
  );
}

/**
 * A device-proxy action reports a refusal inside a 200 body, and `install` is the one action that
 * spells its success field with a capital, so both spellings are read.
 *
 * A body that names no verdict at all is read as success, which is what Revyl's own driver does: its
 * `buildActionResult` starts from `Success: true` and only overwrites it when the worker answered
 * `success: false`. A body that carries an error without a verdict is not read that way, since a
 * worker that names a failure did not perform the action.
 */
function assertWorkerActionSuccess(
  request: RevylRequest,
  response: RevylWorkerActionResponse,
): void {
  const error =
    typeof response.error === 'string' && response.error !== '' ? response.error : undefined;
  const succeeded = response.success ?? response.Success;
  if (succeeded !== false && error === undefined) return;
  throw new AppError(
    'COMMAND_FAILED',
    `Revyl rejected the ${lastPathSegment(request.path)} action${
      error === undefined ? '' : `: ${error}`
    }`,
    {
      reason: response.execution_uncertain === true ? 'provider-unconfirmed' : 'provider-refused',
      path: request.path,
      ...(error === undefined ? {} : { providerDetail: error }),
    },
  );
}

function lastPathSegment(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Revyl reports the same refusal as `detail`, `detail.error`, `message` or `error`. */
function responseDetail(response: RevylResponse): string | undefined {
  const parsed = parseJsonObject(response);
  if (parsed === undefined) return undefined;
  for (const candidate of [parsed.detail, parsed.message, parsed.error]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate.slice(0, 500);
    if (isRecord(candidate) && typeof candidate.error === 'string' && candidate.error.length > 0) {
      return candidate.error.slice(0, 500);
    }
  }
  return undefined;
}

function parseJsonObject(response: RevylResponse): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(response.body));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseJson<T>(request: RevylRequest, response: RevylResponse): T {
  try {
    return JSON.parse(new TextDecoder().decode(response.body)) as T;
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      `Revyl returned a response to ${request.method} ${request.path} that is not JSON (HTTP ${response.status}).`,
      { reason: 'provider-response-invalid', path: request.path },
      error,
    );
  }
}

/**
 * What one Revyl status means, in one place: the code and reason the failure carries, whether the
 * answer left the verdict unknown, and whether the transport may replay the request. Statuses Revyl
 * has no rule for read as a plain failed request.
 */
type RevylStatusVerdict = Readonly<{
  code: AppErrorCode;
  reason: string;
  /** Revyl left it unknown whether the request landed, which is what a hint has to say. */
  uncertain: boolean;
  /** Replaying the request is safe and may succeed, which is what the retry budget is for. */
  retryable: boolean;
}>;

const REVYL_REQUEST_FAILED: RevylStatusVerdict = {
  code: 'COMMAND_FAILED',
  reason: 'provider-request-failed',
  uncertain: false,
  retryable: false,
};

/** A server error Revyl has no rule for: the request went in, the verdict did not come back. */
const REVYL_SERVER_ERROR: RevylStatusVerdict = {
  code: 'COMMAND_FAILED',
  reason: 'provider-unconfirmed',
  uncertain: true,
  retryable: false,
};

/** One table for every status Revyl answers with, so no second classifier reads the same ranges. */
const REVYL_STATUS_VERDICTS: Readonly<Record<number, RevylStatusVerdict>> = {
  400: REVYL_REQUEST_FAILED,
  401: {
    code: 'UNAUTHORIZED',
    reason: 'provider-auth-rejected',
    uncertain: false,
    retryable: false,
  },
  403: {
    code: 'UNAUTHORIZED',
    reason: 'provider-auth-rejected',
    uncertain: false,
    retryable: false,
  },
  404: {
    code: 'SESSION_NOT_FOUND',
    reason: 'provider-session-gone',
    uncertain: false,
    retryable: false,
  },
  408: {
    code: 'COMMAND_FAILED',
    reason: 'provider-unconfirmed',
    uncertain: true,
    retryable: false,
  },
  409: { code: 'COMMAND_FAILED', reason: 'provider-conflict', uncertain: false, retryable: false },
  410: {
    code: 'SESSION_NOT_FOUND',
    reason: 'provider-session-gone',
    uncertain: false,
    retryable: false,
  },
  500: {
    code: 'COMMAND_FAILED',
    reason: 'provider-unconfirmed',
    uncertain: true,
    retryable: false,
  },
  502: { code: 'COMMAND_FAILED', reason: 'provider-unconfirmed', uncertain: true, retryable: true },
  503: { code: 'COMMAND_FAILED', reason: 'provider-unconfirmed', uncertain: true, retryable: true },
  504: { code: 'COMMAND_FAILED', reason: 'provider-unconfirmed', uncertain: true, retryable: true },
};

/**
 * The verdict one status carries, read together with the route that answered. `session-gone` is only
 * ever a session route's answer: a 404 from `start_device` or the credential check is a request the
 * backend did not route, not a session that ended, and reading it as one sends the user to run `open`
 * on a session they already have.
 */
function revylFailure(route: RevylRoute, status: number): RevylStatusVerdict {
  const verdict =
    REVYL_STATUS_VERDICTS[status] ?? (status >= 500 ? REVYL_SERVER_ERROR : REVYL_REQUEST_FAILED);
  if (verdict.reason === 'provider-session-gone' && route !== 'session')
    return REVYL_REQUEST_FAILED;
  return verdict;
}

/**
 * Whether a failure is Revyl's answer that it did not carry the request out: a settled status from the
 * table above, read off the failure's own details. Anything else — an unconfirmed status, a lost
 * answer, an unreachable backend, a cancellation, or a throw with no status at all — leaves it unknown
 * whether the request landed, which is what a caller cleaning up after a side-effecting request has to
 * assume the worst about.
 */
export function revylFailureRefusedTheRequest(error: unknown): boolean {
  const status = error instanceof AppError ? error.details?.providerStatus : undefined;
  return typeof status === 'number' && !revylFailure('general', status).uncertain;
}

/**
 * Whether a failure is Revyl's "no such session" (a session route's 404 or 410). A stop that meets
 * it has already been answered: the session is gone, which is released. Every cleanup path reads it
 * the same way.
 */
export function isRevylSessionGone(error: unknown): boolean {
  return error instanceof AppError && error.details?.reason === 'provider-session-gone';
}

/** HTTPS everywhere; plain HTTP only on loopback, and never with credentials, query, or fragment. */
export function resolveRevylBackendUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('INVALID_ARGS', 'REVYL_API_URL is not a valid URL.', {
      reason: 'invalid_provider_url',
    });
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new AppError(
      'INVALID_ARGS',
      'REVYL_API_URL must use HTTPS; plain HTTP is allowed only on loopback.',
      { reason: 'invalid_provider_url', hint: 'Example: https://backend.revyl.ai' },
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AppError(
      'INVALID_ARGS',
      'REVYL_API_URL must be an origin without credentials, query, or fragment.',
      { reason: 'invalid_provider_url' },
    );
  }
  return url.origin;
}
