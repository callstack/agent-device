import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DeviceLease } from '@agent-device/contracts/device';
import { REVYL_PROVIDER } from './device.ts';
import { createRevylRuntime, type RevylRuntime } from './runtime.ts';

/** One request the fake backend received, with its JSON body decoded. */
export type RevylFixtureRequest = Readonly<{
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  authorization: string | undefined;
  clientHeader: string | undefined;
  agentHeader: string | undefined;
}>;

export type RevylFixtureOptions = Readonly<{
  /**
   * Overrides one response: keyed by `METHOD /path`, the value is the answer to write. A function is
   * called per request, which is how an action that behaves differently on its second call is
   * scripted.
   */
  respond?: Record<string, RevylFixtureResponse | (() => RevylFixtureResponse)>;
  /** Answers the first `worker-connection` polls with these, in order, before the ready one. */
  connectionStatuses?: string[];
  /** Answers `health` with a not-ready answer this many times before the connected one. */
  healthNotReadyPolls?: number;
  /** Answers `health` with Revyl's 503 "worker not attached" this many times before the ready one. */
  healthNotReady503Polls?: number;
  /** Delays every `health` answer this long, which is how a slow worker is modeled. */
  healthDelayMs?: number;
  /** Delays the `start_device` answer this long, which is how a slow rent is modeled. */
  startDelayMs?: number;
  /** The health screen to report. */
  screen?: Readonly<{ width: number; height: number }>;
  /** Reports no screen size at all, which is what a health answer without the fields reads as. */
  withoutScreen?: boolean;
  /** The XML every `hierarchy` answer carries. */
  hierarchy?: string;
  /** The start response body; a run id is generated when absent. */
  startResponse?: Record<string, unknown>;
  /**
   * Holds the session back until `start_device` has answered. A `/stop` sent in that window names a session
   * Revyl never had, which is how a test catches a cleanup that raced the start and read its own 404 as a
   * confirmed release.
   */
  sessionExistsOnceStarted?: boolean;
}>;

export type RevylFixtureBackend = Readonly<{
  backendUrl: string;
  requests: RevylFixtureRequest[];
  /** Paths in arrival order, each spelled `METHOD /path`, which is what the assertions read. */
  paths(): string[];
  /**
   * Paths whose answer has been written back, in completion order. Receipt is the wrong moment for a
   * caller-side assertion: the client has not seen the action succeed yet, so a cancellation that lands
   * then races the response. A test that has to abort after a completed action waits on this.
   */
  answeredPaths(): string[];
  /** The decoded body of the last request whose path ends with `action`. */
  bodyFor(action: string): Record<string, unknown>;
  createRuntime(
    options?: Partial<Readonly<{ deviceModel: string; osVersion: string }>>,
  ): RevylRuntime;
  close(): Promise<void>;
}>;

const DEFAULT_IOS_SCREEN = { width: 390, height: 844 };
const RUN_ID = 'run-1';
/** What the fake answers `start_device` with when the request carries no session id of its own. */
const FALLBACK_SESSION_ID = 'session-1';

/** One answer the fixture writes: what `respond` and `respondWith` accept. */
export type RevylFixtureResponse = {
  status?: number;
  body?: unknown;
  contentType?: string;
  /** Holds the answer back this long before writing it, so a caller's deadline can expire first. */
  delayMs?: number;
};

/**
 * A stand-in for the Revyl execution API: the start/ready/stop handshake the runtime drives, the
 * device-proxy actions it sends, and the request log the assertions read. Every route answers with
 * Revyl's own status and body shapes, and anything that is not one of them is a 404, so a request
 * the runtime should never send shows up as a failed request rather than an action that succeeded.
 */
export async function startRevylFixtureBackend(
  options: RevylFixtureOptions = {},
): Promise<RevylFixtureBackend> {
  const requests: RevylFixtureRequest[] = [];
  /** Each `METHOD /path` whose answer has been written back, in completion order. */
  const answered: string[] = [];
  let connectionPolls = 0;
  let healthPolls = 0;
  let health503Polls = 0;
  /** The platform and session id of the last `start_device`, which is what later answers report. */
  let started: { platform: string; sessionId: string } | undefined;
  /**
   * Whether Revyl would hold a session right now. A session is made when `start_device` is *answered* —
   * with a start delay, later than the request — and a confirmed `/stop` ends it, so a stop sent inside
   * that gap names a session that does not exist yet.
   */
  const sessionIsOpen = () =>
    answered.some((path) => path.endsWith('/start_device')) &&
    !answered.some((path) => path.endsWith('/stop'));
  const screen = options.screen ?? DEFAULT_IOS_SCREEN;

  const overrides = new Map(Object.entries(options.respond ?? {}));
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = request.url ?? '/';
      const method = request.method ?? 'GET';
      const recorded = readJson(raw);
      requests.push({
        method,
        path: url,
        body: recorded,
        authorization: header(request, 'authorization'),
        clientHeader: header(request, 'x-revyl-client'),
        agentHeader: header(request, 'x-revyl-agent'),
      });
      // The answer's own moment, not the request's: a test that waits on `answeredPaths()` knows the
      // response has been written back and the client has its outcome in hand, which `requests` —
      // recorded on receipt — cannot say.
      response.on('finish', () => {
        answered.push(`${method} ${url}`);
      });
      const override = overrides.get(`${method} ${url}`);
      if (override !== undefined) {
        respondWith(response, typeof override === 'function' ? override() : override);
        return;
      }
      answer(url, recorded);
    });

    function answer(url: string, body: Record<string, unknown> | undefined): void {
      const routes: Record<string, () => RevylFixtureResponse> = {
        verify: () => ({ body: { uuid: 'user-1' } }),
        start: () => {
          const sessionId =
            typeof body?.session_id === 'string' ? body.session_id : FALLBACK_SESSION_ID;
          const platform = typeof body?.platform === 'string' ? body.platform : 'ios';
          started = { platform, sessionId };
          return {
            ...(options.startDelayMs === undefined ? {} : { delayMs: options.startDelayMs }),
            body: {
              status: 'started',
              workflow_run_id: RUN_ID,
              session_id: sessionId,
              ...options.startResponse,
            },
          };
        },
        'worker-connection': () => ({ body: nextWorkerConnection() }),
        health: () => nextHealth(),
        hierarchy: () => ({ contentType: 'application/xml', body: options.hierarchy ?? '' }),
        screenshot: () => ({ contentType: 'image/png', body: pngBytes() }),
        stop: () => {
          // With `sessionExistsOnceStarted`, a stop that arrives before the start has answered names a
          // session Revyl never made. The caller must not read that 404 as a release it never got.
          if (options.sessionExistsOnceStarted && !sessionIsOpen()) {
            return { status: 404, body: { detail: 'no such session', error: 'Not Found' } };
          }
          return {
            body: {
              success: true,
              request_accepted: true,
              session_id: sessionIdIn(url) ?? started?.sessionId ?? FALLBACK_SESSION_ID,
            },
          };
        },
        // Every device-proxy action: Revyl answers a working action with success in a 200 body.
        action: () => ({ body: { success: true, action: lastPathSegment(url) } }),
      };
      const route = fixtureRoute(url);
      respondWith(response, (routes[route] ?? unknownRoute(url))());
    }

    /**
     * The worker-connection poll sequence: each scripted status once, then `ready`. A sequence
     * longer than the runtime's patience fails the test on its own rather than repeating forever.
     */
    function nextWorkerConnection(): Record<string, unknown> {
      const status = (options.connectionStatuses ?? [])[connectionPolls] ?? 'ready';
      connectionPolls += 1;
      if (status !== 'ready') return { status, message: 'worker not assigned' };
      return { status: 'ready', workflow_run_id: RUN_ID, worker_ws_url: 'wss://worker.test/ws' };
    }

    /**
     * The health poll sequence: `healthNotReady503Polls` answers of Revyl's "worker not attached"
     * 503, then `healthNotReadyPolls` starting answers, then a connected one. `healthDelayMs` holds
     * each answer back, which is how a worker that answers later than the caller's budget is modeled.
     */
    function nextHealth(): RevylFixtureResponse {
      const notReady = (options.healthNotReadyPolls ?? 0) > healthPolls;
      const workerNotAttached = (options.healthNotReady503Polls ?? 0) > health503Polls;
      healthPolls += 1;
      const delay = { delayMs: options.healthDelayMs };
      if (workerNotAttached) {
        health503Polls += 1;
        return {
          ...delay,
          status: 503,
          body: { detail: 'Worker not attached', error: 'Service Unavailable' },
        };
      }
      if (notReady) return { ...delay, body: { status: 'starting', device_connected: false } };
      return {
        ...delay,
        body: {
          status: 'ok',
          device_connected: true,
          platform: started?.platform ?? 'ios',
          ...(options.withoutScreen
            ? {}
            : { screen_width: screen.width, screen_height: screen.height }),
        },
      };
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const backendUrl = `http://127.0.0.1:${port}`;

  return {
    backendUrl,
    requests,
    paths: () => requests.map((request) => `${request.method} ${request.path}`),
    answeredPaths: () => [...answered],
    bodyFor: (action) => {
      const found = [...requests]
        .reverse()
        .find((request) => request.path.endsWith(`/${action}`) && request.method === 'POST');
      if (!found?.body) throw new Error(`No POST body recorded for ${action}.`);
      return found.body;
    },
    createRuntime: (runtimeOptions) =>
      createRevylRuntime({
        apiKey: 'test-key',
        backendUrl,
        clientVersion: '0.0.0-test',
        ...(runtimeOptions?.deviceModel === undefined
          ? {}
          : { deviceModel: runtimeOptions.deviceModel }),
        ...(runtimeOptions?.osVersion === undefined ? {} : { osVersion: runtimeOptions.osVersion }),
      }).runtime,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function revylLease(platform: 'ios' | 'android', leaseId = 'lease-1'): DeviceLease {
  const now = Date.now();
  return {
    leaseId,
    tenantId: 'tenant',
    runId: 'client-run',
    backend: platform === 'ios' ? 'ios-instance' : 'android-instance',
    leaseProvider: REVYL_PROVIDER,
    createdAt: now,
    heartbeatAt: now,
    expiresAt: now + 60_000,
  };
}

/**
 * The route one request path belongs to. Only Revyl's own routes are recognized: an execution-API
 * path spelled wrong has no route, so the test that asked for it learns about the misspelling.
 */
function fixtureRoute(url: string): string {
  if (url === '/api/v1/entity/users/get_user_uuid') return 'verify';
  if (url === '/api/v1/execution/start_device') return 'start';
  if (url.startsWith('/api/v1/execution/streaming/worker-connection/')) return 'worker-connection';
  if (isDeviceProxyRoute(url)) {
    if (url.endsWith('/health')) return 'health';
    if (url.endsWith('/hierarchy')) return 'hierarchy';
    if (url.endsWith('/screenshot')) return 'screenshot';
    return 'action';
  }
  if (isDeviceSessionRoute(url) && url.endsWith('/stop')) return 'stop';
  if (url.startsWith('/api/v1/execution/device/status/cancel/')) return 'stop';
  return 'unknown';
}

/** Revyl routes every device action below the run's device-proxy prefix. */
function isDeviceProxyRoute(url: string): boolean {
  return url.startsWith('/api/v1/execution/device-proxy/');
}

/** Revyl ends one session below its sessions prefix. */
function isDeviceSessionRoute(url: string): boolean {
  return url.startsWith('/api/v1/execution/device/sessions/');
}

/** The session id one `/device/sessions/<id>/stop` path carries. */
function sessionIdIn(url: string): string | undefined {
  const match = /^\/api\/v1\/execution\/device\/sessions\/([^/]+)\/stop$/.exec(url);
  return match?.[1];
}

/** Revyl's own answer for a path it does not serve, which is what makes a wrong URL a failure. */
function unknownRoute(url: string): () => RevylFixtureResponse {
  return () => ({
    status: 404,
    body: { detail: `Not Found: no route for ${url}`, error: 'Not Found' },
  });
}

/** The device-proxy action one `/.../device-proxy/<run>/<action>` path names. */
function lastPathSegment(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1);
}

function readJson(raw: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function header(request: http.IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function respondWith(
  response: http.ServerResponse,
  result: { status?: number; body?: unknown; contentType?: string; delayMs?: number },
): void {
  const write = () => {
    const contentType = result.contentType ?? 'application/json';
    const payload =
      typeof result.body === 'string' || result.body === undefined
        ? (result.body ?? '')
        : contentType === 'image/png'
          ? Buffer.from(result.body as number[])
          : JSON.stringify(result.body);
    response.writeHead(result.status ?? 200, { 'content-type': contentType });
    response.end(payload);
  };
  if (result.delayMs === undefined) {
    write();
    return;
  }
  setTimeout(write, result.delayMs).unref?.();
}

/** A real 1x1 RGBA PNG, decoded from its base64 form so the fixture body stays short. */
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** The smallest valid PNG: a decoder reading a screenshot body gets a real image. */
function pngBytes(): number[] {
  return [...Buffer.from(PNG_1X1_BASE64, 'base64')];
}
