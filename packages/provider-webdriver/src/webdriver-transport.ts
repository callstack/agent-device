import { setTimeout as sleep } from 'node:timers/promises';
import { AppError } from '@agent-device/kernel/errors';
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

/** Machine-readable `details.reason` of a request that never left the client. */
const WEBDRIVER_CONNECT_REFUSED_REASON = 'webdriver_connect_refused';

/** A request that failed before any bytes reached the driver (refused/unreachable host). */
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
    const idempotent = overrides?.idempotent ?? IDEMPOTENT_METHODS.has(method);
    return await this.requestValueWithRetries(method, path, body, {
      retryAttempts:
        overrides?.retryAttempts ?? (idempotent ? this.requestPolicy.retryAttempts : 0),
      timeoutMs: overrides?.timeoutMs ?? this.requestPolicy.timeoutMs,
      signal: overrides?.signal,
    });
  }

  private async requestValueWithRetries(
    method: string,
    path: string,
    body: unknown,
    overrides: ResolvedWebDriverRequestOverrides,
  ): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= overrides.retryAttempts; attempt += 1) {
      try {
        return await this.requestValueOnce(
          method,
          path,
          body,
          overrides.timeoutMs,
          overrides.signal,
        );
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

  private async requestValueOnce(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
    requestSignal?: AbortSignal,
  ): Promise<unknown> {
    const { ok, status, text } = await this.fetchWebDriver(
      method,
      path,
      body,
      timeoutMs,
      requestSignal,
    );
    const payload = text ? parseJsonResponse(text) : {};
    if (!ok) throw webdriverError(status, payload);
    return readWebDriverValue(payload);
  }

  private async fetchWebDriver(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
    requestSignal?: AbortSignal,
  ): Promise<Pick<Response, 'ok' | 'status'> & { text: string }> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = requestSignal ? AbortSignal.any([requestSignal, timeoutSignal]) : timeoutSignal;
    try {
      const response = await fetch(new URL(trimLeadingSlash(path), this.endpoint), {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...this.headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      return { ok: response.ok, status: response.status, text: await response.text() };
    } catch (error) {
      throw classifyWebDriverFetchFailure(error, {
        method,
        path,
        timeoutMs,
        timeoutSignal,
        requestSignal,
      });
    }
  }
}

/**
 * A caller's own cancellation keeps its reason as-is. Only a failure the
 * transport itself can explain — its deadline, or a network failure fetch
 * reports as a bare TypeError — becomes a typed error, so callers key on
 * `details.reason` instead of sniffing fetch's DOMException name.
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
): unknown {
  const { method, path, timeoutMs, timeoutSignal, requestSignal } = context;
  if (requestSignal?.aborted) return error;
  if (timeoutSignal.aborted) return webdriverTimeoutError(method, path, timeoutMs, error);
  // Fetch rejects with a bare TypeError for a network failure — refused
  // connection, unresolved host, failed handshake — that never put a byte on
  // the wire.
  if (error instanceof TypeError) return webdriverConnectRefusedError(method, path, error);
  return error;
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
  return new AppError('COMMAND_FAILED', message, {
    status,
    response: payload,
    // A 5xx means the driver received and processed the request, but not
    // whether the mutation it described completed before it failed.
    ...(status >= 500 ? { dispatched: 'unknown' as const } : {}),
    ...(isUnsupportedRouteAnswer(status, payload) ? { dispatched: 'no' as const } : {}),
  });
}

/** W3C `error` codes a driver answers with when it does not implement the route at all. */
const UNSUPPORTED_ROUTE_ERROR_CODES: ReadonlySet<string> = new Set([
  'unknown command',
  'unknown method',
]);

/**
 * A W3C `unknown command`/`unknown method` code, or a bare 404/405 that carries no W3C error code
 * (a server that does not know the path). A 404 that names another W3C code, such as
 * `invalid session id` or `no such element`, is a different answer and never counts.
 */
function isUnsupportedRouteAnswer(status: number, payload: unknown): boolean {
  const value =
    payload && typeof payload === 'object' && 'value' in payload
      ? (payload as { value?: unknown }).value
      : undefined;
  const code =
    value && typeof value === 'object' ? (value as { error?: unknown }).error : undefined;
  if (typeof code === 'string') return UNSUPPORTED_ROUTE_ERROR_CODES.has(code);
  return status === 404 || status === 405;
}

/**
 * The driver answered that it does not implement the route, so nothing was dispatched and a
 * sibling route for the same action may be tried. A timeout or 5xx is not this answer: the first
 * route may already have acted.
 */
export function isWebDriverRouteUnsupported(error: unknown): error is AppError {
  return (
    error instanceof AppError &&
    error.details?.dispatched === 'no' &&
    typeof error.details.status === 'number'
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
      reason: WEBDRIVER_REQUEST_TIMEOUT_REASON,
      method,
      path,
      timeoutMs,
      // The transport stopped waiting; the driver may still be mid-request.
      dispatched: 'unknown' as const,
    },
    cause instanceof Error ? cause : undefined,
  );
}

function webdriverConnectRefusedError(method: string, path: string, cause: TypeError): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `WebDriver ${method} ${path} could not reach the driver.`,
    {
      reason: WEBDRIVER_CONNECT_REFUSED_REASON,
      method,
      path,
      // The connection itself failed, so no bytes of this request were sent.
      dispatched: 'no' as const,
    },
    cause,
  );
}

function isRetriableWebDriverError(error: unknown): boolean {
  if (isWebDriverRequestTimeout(error)) return true;
  if (isWebDriverConnectRefused(error)) return true;
  if (error instanceof AppError) {
    const status = error.details?.status;
    return typeof status === 'number' && status >= 500;
  }
  return false;
}
