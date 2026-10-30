import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DeviceLease } from '@agent-device/contracts/device';
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
  /** Overrides one response: keyed by `METHOD /path`, the value is what to answer with. */
  respond?: Record<
    string,
    { status?: number; body?: unknown; contentType?: string } | (() => unknown)
  >;
  /** Answers every `worker-connection` poll with this before the ready one. */
  connectionStatuses?: string[];
  /** Answers `health` with this on the first poll before the connected one. */
  healthNotReadyPolls?: number;
  /** The health screen to report. */
  screen?: Readonly<{ width: number; height: number }>;
  /** Reports no screen size at all, which is what a health answer without the fields reads as. */
  withoutScreen?: boolean;
  /** The XML every `hierarchy` answer carries. */
  hierarchy?: string;
  /** The start response body; a run id is generated when absent. */
  startResponse?: Record<string, unknown>;
}>;

export type RevylFixtureBackend = Readonly<{
  backendUrl: string;
  requests: RevylFixtureRequest[];
  /** Paths in arrival order, each spelled `METHOD /path`, which is what the assertions read. */
  paths(): string[];
  /** The decoded body of the last request whose path ends with `action`. */
  bodyFor(action: string): Record<string, unknown>;
  createRuntime(
    options?: Partial<Readonly<{ deviceModel: string; osVersion: string }>>,
  ): RevylRuntime;
  close(): Promise<void>;
}>;

const DEFAULT_IOS_SCREEN = { width: 390, height: 844 };
const SESSION_ID = 'session-1';
const RUN_ID = 'run-1';

/** One answer the fixture writes: what `respondWith` accepts. */
type FixtureResponse = { status?: number; body?: unknown; contentType?: string };

/**
 * A stand-in for the Revyl execution API: the start/ready/stop handshake the runtime drives, the
 * device-proxy actions it sends, and the request log the assertions read. Every route answers with
 * Revyl's own status and body shapes, so a request the runtime should never send is a missing log
 * entry rather than a mock that accepted it.
 */
export async function startRevylFixtureBackend(
  options: RevylFixtureOptions = {},
): Promise<RevylFixtureBackend> {
  const requests: RevylFixtureRequest[] = [];
  let connectionPolls = 0;
  let healthPolls = 0;
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
      const override = overrides.get(`${method} ${url}`);
      if (typeof override === 'function') {
        const value = override();
        respondWith(response, { body: value });
        return;
      }
      if (override !== undefined) {
        respondWith(response, override);
        return;
      }
      answer(url);
    });

    function answer(url: string): void {
      const routes: Record<string, () => FixtureResponse> = {
        verify: () => ({ body: { uuid: 'user-1' } }),
        start: () => ({
          body: {
            status: 'started',
            workflow_run_id: RUN_ID,
            session_id: SESSION_ID,
            ...options.startResponse,
          },
        }),
        'worker-connection': () => ({ body: nextWorkerConnection() }),
        health: () => ({ body: nextHealth(url) }),
        hierarchy: () => ({ contentType: 'application/xml', body: options.hierarchy ?? '' }),
        screenshot: () => ({ contentType: 'image/png', body: pngBytes() }),
        stop: () => ({ body: { success: true, session_id: SESSION_ID } }),
        // Every device-proxy action: Revyl answers a working action with success in a 200 body.
        action: () => ({ body: { success: true, action: lastPathSegment(url) } }),
      };
      respondWith(response, (routes[fixtureRoute(url)] ?? routes.action!)());
    }

    /** The worker-connection poll sequence: the scripted statuses, then `ready`. */
    function nextWorkerConnection(): Record<string, unknown> {
      const statuses = options.connectionStatuses ?? [];
      const status = statuses[Math.min(connectionPolls, statuses.length - 1)] ?? 'ready';
      connectionPolls += 1;
      if (status !== 'ready') return { status, message: 'worker not assigned' };
      return { status: 'ready', workflow_run_id: RUN_ID, worker_ws_url: 'wss://worker.test/ws' };
    }

    /** The health poll sequence: `healthNotReadyPolls` starting answers, then a connected one. */
    function nextHealth(url: string): Record<string, unknown> {
      const notReady = (options.healthNotReadyPolls ?? 0) > healthPolls;
      healthPolls += 1;
      if (notReady) return { status: 'starting', device_connected: false };
      return {
        status: 'ok',
        device_connected: true,
        platform: url.includes('android') ? 'android' : 'ios',
        ...(options.withoutScreen
          ? {}
          : { screen_width: screen.width, screen_height: screen.height }),
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
      }),
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
    leaseProvider: 'revyl',
    createdAt: now,
    heartbeatAt: now,
    expiresAt: now + 60_000,
  };
}

/** The route one request path belongs to; anything unlisted is a device-proxy action. */
function fixtureRoute(url: string): string {
  if (url === '/api/v1/entity/users/get_user_uuid') return 'verify';
  if (url === '/api/v1/execution/start_device') return 'start';
  if (url.startsWith('/api/v1/execution/streaming/worker-connection/')) return 'worker-connection';
  if (url.endsWith('/health')) return 'health';
  if (url.endsWith('/hierarchy')) return 'hierarchy';
  if (url.endsWith('/screenshot')) return 'screenshot';
  if (url.endsWith('/stop') || url.includes('/status/cancel/')) return 'stop';
  return 'action';
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
  result: { status?: number; body?: unknown; contentType?: string },
): void {
  const contentType = result.contentType ?? 'application/json';
  const payload =
    typeof result.body === 'string' || result.body === undefined
      ? (result.body ?? '')
      : contentType === 'image/png'
        ? Buffer.from(result.body as number[])
        : JSON.stringify(result.body);
  response.writeHead(result.status ?? 200, { 'content-type': contentType });
  response.end(payload);
}

/** The smallest valid PNG: the runtime treats a screenshot body as opaque bytes. */
function pngBytes(): number[] {
  return [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89,
  ];
}
