import { setTimeout as sleep } from 'node:timers/promises';
import type { DiagnosticEventInput } from '@agent-device/contracts/host-diagnostics';
import { AppError, type DispatchDisclosure, type ReasonTable } from '@agent-device/kernel/errors';
import { agentDeviceRequestHeaders } from './request-headers.ts';
import { basicAuthHeader, trimLeadingSlash, withTrailingSlash } from './webdriver-utils.ts';

/** Why a WebDriver request failed at the transport. */
const WEBDRIVER_TRANSPORT_REASONS = {
  // The transport stopped waiting on a WebDriver request the driver may still be carrying out.
  requestTimeout: { reason: 'webdriver_request_timeout' },
  // The request never reached the driver: the connection was refused or the host is unreachable.
  connectRefused: { reason: 'webdriver_connect_refused' },
  // The connection to the driver failed after the request may have reached it.
  requestInterrupted: { reason: 'webdriver_request_interrupted' },
  // The driver answered that it does not implement the route.
  routeUnsupported: { reason: 'webdriver_route_unsupported' },
} as const satisfies ReasonTable<'webdriver provider'>;

export type WebDriverAuth = {
  username: string;
  accessKey: string;
};

export type WebDriverRequestPolicy = {
  timeoutMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
  /**
   * Budget for creating the session, consumed by `WebDriverClient.createSession`
   * rather than the transport: a cloud provider allocates a physical device
   * inside that one request, so it cannot share `timeoutMs`, which is sized for
   * a settled session's round trips.
   */
  sessionCreateTimeoutMs?: number;
};

/** A request the transport stopped waiting on; the server may still complete it. */
export function isWebDriverRequestTimeout(error: unknown): error is AppError {
  return (
    error instanceof AppError &&
    error.details?.reason === WEBDRIVER_TRANSPORT_REASONS.requestTimeout.reason
  );
}

/**
 * What a failed request discloses about whether the driver acted on it. WebDriver never proves
 * that a request executed, so a failure is either `no` (the request never reached the driver) or
 * `unknown`.
 */
function dispatchDisclosure(dispatched: DispatchDisclosure): { dispatched: DispatchDisclosure } {
  return { dispatched };
}

/**
 * Socket error codes that prove the connection was never established, so no byte of the request
 * reached the driver.
 */
const PRE_CONNECT_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** How deep the `cause` and `AggregateError` chain is read for socket error codes. */
const ERROR_CAUSE_DEPTH_LIMIT = 4;

/** A request whose connection failed before it was established (refused or unreachable host). */
export function isWebDriverConnectRefused(error: unknown): error is AppError {
  return (
    error instanceof AppError &&
    error.details?.reason === WEBDRIVER_TRANSPORT_REASONS.connectRefused.reason
  );
}

export type WebDriverRequestOverrides = {
  retryAttempts?: number;
  /**
   * The request reads and changes nothing, so a resend after an ambiguous failure is safe. GET
   * requests are idempotent by method; this marks a read the protocol sends as a POST, such as a
   * `mobile:` read script.
   */
  idempotent?: boolean;
  /**
   * Per-request transport bound, for callers whose own budget is far shorter
   * than the client's default. Without it a caller waiting 2s on a poll can be
   * held for the full default timeout by one hung request.
   */
  timeoutMs?: number;
  /** Request-bound cancellation supplied by a runtime binding. */
  signal?: AbortSignal;
};

export type WebDriverTransportOptions = {
  clientVersion: string;
  endpoint: string | URL;
  auth?: WebDriverAuth;
  headers?: Record<string, string>;
  diagnostics?: Readonly<{ emit(event: DiagnosticEventInput): void }>;
  /** Session creation is the client's phase; the transport sees only per-request policy. */
  requestPolicy?: Omit<WebDriverRequestPolicy, 'sessionCreateTimeoutMs'>;
};

type WebDriverResponse = {
  value?: unknown;
  sessionId?: string;
};

type ResolvedWebDriverRequestOverrides = {
  timeoutMs: number;
  retryAttempts: number;
  signal?: AbortSignal;
};

type ResolvedWebDriverRequestPolicy = Required<
  NonNullable<WebDriverTransportOptions['requestPolicy']>
>;

/**
 * Only a request that changes nothing gets the policy's retry budget. A resend after an ambiguous
 * outcome (a timeout, or a 5xx after the driver received the request) cannot tell whether the first
 * attempt's side effect already landed, so every other request gets exactly one attempt.
 */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/**
 * What a POST without parameters carries. The W3C WebDriver protocol makes every POST body a JSON
 * object, and a gateway in front of the driver may enforce it: AWS Device Farm's remote access
 * endpoint refuses a bodyless `POST /back` with `Value null at 'payload'`, while Appium itself
 * accepts either.
 */
const EMPTY_POST_BODY: Readonly<Record<string, never>> = Object.freeze({});

/** A successful WebDriver answer: its HTTP status and the unwrapped W3C `value`. */
export type WebDriverAnswer = { status: number; value: unknown };

/** Focused HTTP/retry policy for one WebDriver endpoint; session semantics stay in WebDriverClient. */
export class WebDriverTransport {
  private readonly endpoint: URL;
  private readonly headers: Record<string, string>;
  private readonly requestPolicy: ResolvedWebDriverRequestPolicy;
  private readonly diagnostics: WebDriverTransportOptions['diagnostics'];

  constructor(options: WebDriverTransportOptions) {
    this.diagnostics = options.diagnostics;
    this.endpoint = withTrailingSlash(new URL(options.endpoint));
    this.headers = {
      ...agentDeviceRequestHeaders(options.clientVersion),
      ...(options.auth ? { Authorization: basicAuthHeader(options.auth) } : {}),
      ...options.headers,
    };
    this.requestPolicy = {
      timeoutMs: options.requestPolicy?.timeoutMs ?? 30_000,
      retryAttempts: options.requestPolicy?.retryAttempts ?? 1,
      retryDelayMs: options.requestPolicy?.retryDelayMs ?? 250,
    };
  }

  async requestValue(
    method: string,
    path: string,
    body?: unknown,
    overrides?: WebDriverRequestOverrides,
  ): Promise<unknown> {
    return (await this.request(method, path, body, overrides)).value;
  }

  /** The request's answer with the HTTP status it arrived with. */
  async request(
    method: string,
    path: string,
    body?: unknown,
    overrides?: WebDriverRequestOverrides,
  ): Promise<WebDriverAnswer> {
    const idempotent = overrides?.idempotent ?? IDEMPOTENT_METHODS.has(method);
    return await this.requestWithRetries(method, path, body, {
      retryAttempts:
        overrides?.retryAttempts ?? (idempotent ? this.requestPolicy.retryAttempts : 0),
      timeoutMs: overrides?.timeoutMs ?? this.requestPolicy.timeoutMs,
      signal: overrides?.signal,
    });
  }

  private async requestWithRetries(
    method: string,
    path: string,
    body: unknown,
    overrides: ResolvedWebDriverRequestOverrides,
  ): Promise<WebDriverAnswer> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= overrides.retryAttempts; attempt += 1) {
      try {
        return await this.requestOnce(method, path, body, overrides.timeoutMs, overrides.signal);
      } catch (error) {
        lastError = error;
        if (
          !shouldRetryWebDriverRequest(error, attempt, overrides.retryAttempts, overrides.signal)
        ) {
          throw error;
        }
        await sleep(this.requestPolicy.retryDelayMs, undefined, { signal: overrides.signal });
      }
    }
    throw lastError;
  }

  private async requestOnce(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
    requestSignal?: AbortSignal,
  ): Promise<WebDriverAnswer> {
    const { ok, status, text } = await this.fetchWebDriver(
      method,
      path,
      body,
      timeoutMs,
      requestSignal,
    );
    if (ok)
      return { status, value: readWebDriverValue(text ? parseJsonResponse(text, status) : {}) };
    const parsed = text ? parseJsonBody(text) : { json: {} };
    if (parsed === undefined) throw nonJsonAnswerError(status, text);
    const payload = parsed.json;
    const error = webdriverError(status, payload);
    if (isWebDriverRouteUnsupported(error)) {
      this.emitDiagnostic(WEBDRIVER_TRANSPORT_REASONS.routeUnsupported.reason, {
        method,
        path,
        status,
        code: w3cErrorCode(payload) ?? null,
      });
    }
    throw error;
  }

  emitDiagnostic(phase: string, data: Record<string, unknown>): void {
    this.diagnostics?.emit({ level: 'debug', phase, data });
  }

  private async fetchWebDriver(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
    requestSignal?: AbortSignal,
  ): Promise<Pick<Response, 'ok' | 'status'> & { text: string }> {
    const url = new URL(trimLeadingSlash(path), this.endpoint);
    const payload = body === undefined && method === 'POST' ? EMPTY_POST_BODY : body;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = requestSignal ? AbortSignal.any([requestSignal, timeoutSignal]) : timeoutSignal;
    const failure = { method, path, timeoutMs, timeoutSignal, requestSignal };
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...this.headers,
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      throw classifyWebDriverFetchFailure(error, failure, 'request');
    }
    try {
      return { ok: response.ok, status: response.status, text: await response.text() };
    } catch (error) {
      throw classifyWebDriverFetchFailure(error, failure, 'response');
    }
  }
}

/**
 * A caller's own cancellation keeps its reason as-is. Only a failure the transport itself can
 * explain — its deadline, or a network failure fetch reports as a TypeError — becomes a typed
 * error, so callers key on `details.reason` instead of sniffing fetch's error names. A failure
 * discloses `no` only when a socket error code proves the connection was never established;
 * any other network failure, and every failure after the response headers arrived, is `unknown`.
 */
function classifyWebDriverFetchFailure(
  error: unknown,
  context: {
    method: string;
    path: string;
    timeoutMs: number;
    timeoutSignal: AbortSignal;
    requestSignal: AbortSignal | undefined;
  },
  stage: 'request' | 'response',
): unknown {
  const { method, path, timeoutMs, timeoutSignal, requestSignal } = context;
  if (requestSignal?.aborted) return error;
  if (timeoutSignal.aborted) return webdriverTimeoutError(method, path, timeoutMs, error);
  if (stage === 'request' && failedBeforeConnect(error)) {
    return webdriverConnectRefusedError(method, path, error);
  }
  if (stage === 'response' || error instanceof TypeError) {
    return webdriverRequestInterruptedError(method, path, error);
  }
  return error;
}

function failedBeforeConnect(error: unknown): boolean {
  const codes = socketErrorCodes(error, 0);
  return codes.length > 0 && codes.every((code) => PRE_CONNECT_ERROR_CODES.has(code));
}

/** Every `code` on the error, its `cause` chain, and each `AggregateError` member. */
function socketErrorCodes(error: unknown, depth: number): string[] {
  if (depth > ERROR_CAUSE_DEPTH_LIMIT || !error || typeof error !== 'object') return [];
  const { code, cause } = error as { code?: unknown; cause?: unknown };
  const members: unknown[] = error instanceof AggregateError ? error.errors : [];
  return [
    ...(typeof code === 'string' ? [code] : []),
    ...socketErrorCodes(cause, depth + 1),
    ...members.flatMap((member) => socketErrorCodes(member, depth + 1)),
  ];
}

function shouldRetryWebDriverRequest(
  error: unknown,
  attempt: number,
  retryAttempts: number,
  signal: AbortSignal | undefined,
): boolean {
  return !signal?.aborted && isRetriableWebDriverError(error) && attempt < retryAttempts;
}

function readWebDriverValue(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const response = payload as WebDriverResponse;
  if ('value' in response) return response.value;
  return payload;
}

/** The longest raw response body an error carries as evidence. */
const RESPONSE_BODY_EVIDENCE_LIMIT = 500;

function parseJsonResponse(text: string, status: number): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      'WebDriver response was not valid JSON.',
      // A 2xx means the driver ran the request; only its answer is unreadable.
      { status, text: truncateBody(text), ...dispatchDisclosure('unknown') },
      error,
    );
  }
}

/** The parsed body, boxed so a JSON `null` stays distinct from a body that is not JSON. */
function parseJsonBody(text: string): { json: unknown } | undefined {
  try {
    return { json: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

function truncateBody(text: string): string {
  return text.length > RESPONSE_BODY_EVIDENCE_LIMIT
    ? `${text.slice(0, RESPONSE_BODY_EVIDENCE_LIMIT)}…`
    : text;
}

function webdriverError(status: number, payload: unknown): AppError {
  const value =
    payload && typeof payload === 'object' && 'value' in payload
      ? (payload as { value?: unknown }).value
      : payload;
  const message =
    value &&
    typeof value === 'object' &&
    typeof (value as { message?: unknown }).message === 'string'
      ? (value as { message: string }).message
      : `WebDriver request failed with HTTP ${status}.`;
  if (isUnsupportedRouteAnswer(status, payload)) {
    return new AppError('COMMAND_FAILED', message, {
      ...unsupportedRouteRefusal(),
      status,
      response: payload,
    });
  }
  return new AppError('COMMAND_FAILED', message, {
    status,
    response: payload,
    // A 5xx means the driver received and processed the request, but not
    // whether the mutation it described completed before it failed.
    ...(status >= 500 ? dispatchDisclosure('unknown') : {}),
  });
}

/**
 * A non-JSON error answer comes from something in front of the driver (a gateway's `502 <html>`
 * or a proxy's `404` page), not from the driver. Its status still decides retry, but it is never
 * the driver's refusal of a route, so no sibling route is tried, and it cannot say whether the
 * driver received the request. The raw body is truncated evidence only.
 */
function nonJsonAnswerError(status: number, text: string): AppError {
  return new AppError('COMMAND_FAILED', `WebDriver request failed with HTTP ${status}.`, {
    status,
    response: truncateBody(text),
    ...dispatchDisclosure('unknown'),
  });
}

/**
 * The driver answered with the W3C `invalid session id` error: the session it was asked about does
 * not exist (never did, was deleted, or timed out on the driver).
 */
export function isWebDriverInvalidSession(error: unknown): error is AppError {
  return (
    error instanceof AppError &&
    error.details?.status === 404 &&
    w3cErrorCode(error.details.response)?.toLowerCase() === 'invalid session id'
  );
}

/**
 * The details of a refusal the driver answered before running anything: it does not implement
 * the route. A command that tried every route it has and was refused by each carries the same.
 */
export function unsupportedRouteRefusal(): {
  reason: typeof WEBDRIVER_TRANSPORT_REASONS.routeUnsupported.reason;
  dispatched: DispatchDisclosure;
} {
  return {
    reason: WEBDRIVER_TRANSPORT_REASONS.routeUnsupported.reason,
    ...dispatchDisclosure('no'),
  };
}

/** W3C `error` codes a driver answers with when it does not implement the route. */
const UNSUPPORTED_ROUTE_ERROR_CODES: ReadonlySet<string> = new Set([
  'unknown command',
  'unknown method',
]);

/** HTTP statuses that, without a W3C error code, mean the route is not implemented here. */
const UNSUPPORTED_ROUTE_STATUSES: ReadonlySet<number> = new Set([404, 405, 501]);

/**
 * A W3C error code decides when the driver sent one, because other failures share these statuses
 * (a 404 `invalid session id` is a dead session); with no code, a bare 404 (no such route), 405
 * (the route exists but not for this method), or 501 (the driver declares it not implemented)
 * means the route is not implemented by this driver.
 */
function isUnsupportedRouteAnswer(status: number, payload: unknown): boolean {
  const code = w3cErrorCode(payload);
  if (code !== undefined) return UNSUPPORTED_ROUTE_ERROR_CODES.has(code.toLowerCase());
  return UNSUPPORTED_ROUTE_STATUSES.has(status);
}

/** The W3C `value.error` string of a response body, if it carries one. */
function w3cErrorCode(payload: unknown): string | undefined {
  const value =
    payload && typeof payload === 'object' && 'value' in payload
      ? (payload as { value?: unknown }).value
      : undefined;
  const code =
    value && typeof value === 'object' ? (value as { error?: unknown }).error : undefined;
  return typeof code === 'string' ? code : undefined;
}

/**
 * The driver answered that it does not implement the route, so nothing was dispatched and a
 * sibling route for the same action may be tried. A timeout or 5xx is not this answer: the first
 * route may already have acted.
 */
export function isWebDriverRouteUnsupported(error: unknown): error is AppError {
  return (
    error instanceof AppError &&
    error.details?.reason === WEBDRIVER_TRANSPORT_REASONS.routeUnsupported.reason
  );
}

function webdriverTimeoutError(
  method: string,
  path: string,
  timeoutMs: number,
  cause: unknown,
): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `WebDriver ${method} ${path} timed out after ${timeoutMs}ms.`,
    {
      reason: WEBDRIVER_TRANSPORT_REASONS.requestTimeout.reason,
      method,
      path,
      timeoutMs,
      // The transport stopped waiting; the driver may still be mid-request.
      ...dispatchDisclosure('unknown'),
    },
    cause instanceof Error ? cause : undefined,
  );
}

function webdriverConnectRefusedError(method: string, path: string, cause: unknown): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `WebDriver ${method} ${path} could not reach the driver.`,
    {
      reason: WEBDRIVER_TRANSPORT_REASONS.connectRefused.reason,
      method,
      path,
      ...dispatchDisclosure('no'),
    },
    cause instanceof Error ? cause : undefined,
  );
}

function webdriverRequestInterruptedError(method: string, path: string, cause: unknown): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `WebDriver ${method} ${path} lost its connection to the driver.`,
    {
      reason: WEBDRIVER_TRANSPORT_REASONS.requestInterrupted.reason,
      method,
      path,
      ...dispatchDisclosure('unknown'),
    },
    cause instanceof Error ? cause : undefined,
  );
}

function isRetriableWebDriverError(error: unknown): boolean {
  if (isWebDriverRequestTimeout(error)) return true;
  if (isWebDriverConnectRefused(error)) return true;
  if (
    error instanceof AppError &&
    error.details?.reason === WEBDRIVER_TRANSPORT_REASONS.requestInterrupted.reason
  ) {
    return true;
  }
  if (error instanceof AppError) {
    const status = error.details?.status;
    return typeof status === 'number' && status >= 500;
  }
  return false;
}
