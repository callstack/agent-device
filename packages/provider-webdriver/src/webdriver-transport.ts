import { setTimeout as sleep } from 'node:timers/promises';
import { AppError, type DispatchDisclosure } from '@agent-device/kernel/errors';
import { agentDeviceRequestHeaders } from './request-headers.ts';
import { basicAuthHeader, trimLeadingSlash, withTrailingSlash } from './webdriver-utils.ts';

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

/** Machine-readable `details.reason` of a request the transport gave up waiting on. */
const WEBDRIVER_REQUEST_TIMEOUT_REASON = 'webdriver_request_timeout';

/** A request the transport stopped waiting on; the server may still complete it. */
export function isWebDriverRequestTimeout(error: unknown): error is AppError {
  return error instanceof AppError && error.details?.reason === WEBDRIVER_REQUEST_TIMEOUT_REASON;
}

/**
 * What a failed request discloses about whether the driver acted on it. WebDriver never proves
 * that a request executed, so a failure is either `no` (the request never reached the driver) or
 * `unknown`.
 */
function dispatchDisclosure(dispatched: DispatchDisclosure): { dispatched: DispatchDisclosure } {
  return { dispatched };
}

/** Machine-readable `details.reason` of a request that never reached the driver. */
const WEBDRIVER_CONNECT_REFUSED_REASON = 'webdriver_connect_refused';

/**
 * Machine-readable `details.reason` of a request whose connection failed after it may have
 * reached the driver: a socket reset, or a response body cut off after the status line.
 */
const WEBDRIVER_REQUEST_INTERRUPTED_REASON = 'webdriver_request_interrupted';

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
  return error instanceof AppError && error.details?.reason === WEBDRIVER_CONNECT_REFUSED_REASON;
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

/** A successful WebDriver answer: its HTTP status and the unwrapped W3C `value`. */
export type WebDriverAnswer = { status: number; value: unknown };

/** Focused HTTP/retry policy for one WebDriver endpoint; session semantics stay in WebDriverClient. */
export class WebDriverTransport {
  private readonly endpoint: URL;
  private readonly headers: Record<string, string>;
  private readonly requestPolicy: ResolvedWebDriverRequestPolicy;

  constructor(options: WebDriverTransportOptions) {
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
    const payload = text ? parseJsonResponse(text) : {};
    if (ok) return { status, value: readWebDriverValue(payload) };
    const error = webdriverError(status, payload);
    if (isWebDriverRouteUnsupported(error)) {
      emitWebDriverDiagnostic(WEBDRIVER_ROUTE_UNSUPPORTED_REASON, {
        method,
        path,
        status,
        code: w3cErrorCode(payload) ?? null,
      });
    }
    throw error;
  }

  private async fetchWebDriver(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
    requestSignal?: AbortSignal,
  ): Promise<Pick<Response, 'ok' | 'status'> & { text: string }> {
    const url = new URL(trimLeadingSlash(path), this.endpoint);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = requestSignal ? AbortSignal.any([requestSignal, timeoutSignal]) : timeoutSignal;
    const failure = { method, path, timeoutMs, timeoutSignal, requestSignal };
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...this.headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
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

function parseJsonResponse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new AppError('COMMAND_FAILED', 'WebDriver response was not valid JSON.', { text }, error);
  }
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

/** Machine-readable `details.reason` of a driver answer that it does not implement the route. */
const WEBDRIVER_ROUTE_UNSUPPORTED_REASON = 'webdriver_route_unsupported';

/**
 * The details of a refusal the driver answered before running anything: it does not implement
 * the route. A command that tried every route it has and was refused by each carries the same.
 */
export function unsupportedRouteRefusal(): {
  reason: typeof WEBDRIVER_ROUTE_UNSUPPORTED_REASON;
  dispatched: DispatchDisclosure;
} {
  return { reason: WEBDRIVER_ROUTE_UNSUPPORTED_REASON, ...dispatchDisclosure('no') };
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
 * Records a debug event in the request diagnostics. The emitter loads on demand because the
 * events are rare and the transport sits in the provider's eager import closure.
 */
export function emitWebDriverDiagnostic(phase: string, data: Record<string, unknown>): void {
  void import('@agent-device/host-kit/diagnostics')
    .then(({ emitDiagnostic }) => emitDiagnostic({ level: 'debug', phase, data }))
    .catch(() => undefined);
}

/**
 * The driver answered that it does not implement the route, so nothing was dispatched and a
 * sibling route for the same action may be tried. A timeout or 5xx is not this answer: the first
 * route may already have acted.
 */
export function isWebDriverRouteUnsupported(error: unknown): error is AppError {
  return error instanceof AppError && error.details?.reason === WEBDRIVER_ROUTE_UNSUPPORTED_REASON;
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
      reason: WEBDRIVER_REQUEST_TIMEOUT_REASON,
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
      reason: WEBDRIVER_CONNECT_REFUSED_REASON,
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
      reason: WEBDRIVER_REQUEST_INTERRUPTED_REASON,
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
  if (error instanceof AppError && error.details?.reason === WEBDRIVER_REQUEST_INTERRUPTED_REASON) {
    return true;
  }
  if (error instanceof AppError) {
    const status = error.details?.status;
    return typeof status === 'number' && status >= 500;
  }
  return false;
}
