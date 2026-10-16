import { AppError } from '@agent-device/kernel/errors';

const TARGET_LIST_TIMEOUT_MS = 3_000;
const CONNECT_TIMEOUT_MS = 5_000;
const EVALUATE_TIMEOUT_MS = 30_000;

/** One debuggable JavaScript runtime the dev server's inspector proxy lists at `/json/list`. */
export type MetroInspectorTarget = {
  id: string;
  title: string;
  description?: string;
  appId?: string;
  deviceName?: string;
  webSocketDebuggerUrl: string;
  /** Present on React Native runtimes; absent on auxiliary targets such as legacy Hermes pages. */
  reactNative?: { logicalDeviceId?: string };
};

/**
 * App id the dev server reports for a target. Newer inspector proxies set `appId`; older ones only
 * put the bundle id or package name in `description`.
 */
export function targetAppId(target: MetroInspectorTarget): string {
  return target.appId ?? target.description ?? target.title;
}

export async function listMetroInspectorTargets(serverUrl: URL): Promise<MetroInspectorTarget[]> {
  const listUrl = new URL('json/list', withTrailingSlash(serverUrl));
  let response: Response;
  try {
    response = await fetch(listUrl, { signal: AbortSignal.timeout(TARGET_LIST_TIMEOUT_MS) });
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      `Could not reach the React Native dev server at ${serverUrl.origin}.`,
      {
        hint: 'Start Metro (or Expo/Re.Pack) for the app, or pass --metro-port/--metro-host when it does not run on localhost:8081.',
      },
      error,
    );
  }
  if (!response.ok) {
    throw new AppError(
      'COMMAND_FAILED',
      `The dev server at ${serverUrl.origin} answered ${response.status} for /json/list.`,
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!Array.isArray(body)) {
    throw new AppError(
      'COMMAND_FAILED',
      `The server at ${serverUrl.origin} is not a React Native dev server: /json/list returned no target list.`,
      { hint: "Pass --metro-port/--metro-host for the app's Metro, Expo, or Re.Pack dev server." },
    );
  }
  return body.filter(isInspectorTarget);
}

function isInspectorTarget(value: unknown): value is MetroInspectorTarget {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.webSocketDebuggerUrl === 'string';
}

/** Secondary JavaScript runtimes, such as Reanimated's UI runtime, that render no React tree. */
const WORKLET_RUNTIME_PATTERN = /reanimated|worklet/i;

function pageNumber(target: MetroInspectorTarget): number {
  const suffix = Number.parseInt(target.id.slice(target.id.lastIndexOf('-') + 1), 10);
  return Number.isInteger(suffix) ? suffix : Number.MAX_SAFE_INTEGER;
}

/** Identifies the device behind a target; display names can repeat, so they are the last resort. */
function deviceKey(target: MetroInspectorTarget): string {
  const separator = target.id.lastIndexOf('-');
  return (
    target.reactNative?.logicalDeviceId ??
    (separator > 0 ? target.id.slice(0, separator) : undefined) ??
    target.deviceName ??
    target.id
  );
}

export type RuntimeTargetFilter = {
  /** Bundle id or package name, as the dev server reports it. */
  appId?: string;
  /** Device name or logical device id, as the dev server reports it. */
  device?: string;
};

function isAppRuntime(target: MetroInspectorTarget): boolean {
  return (
    target.reactNative !== undefined && !WORKLET_RUNTIME_PATTERN.test(target.description ?? '')
  );
}

function matchesFilter(target: MetroInspectorTarget, filter: RuntimeTargetFilter): boolean {
  const app = filter.appId === undefined || targetAppId(target) === filter.appId;
  const device =
    filter.device === undefined ||
    target.deviceName === filter.device ||
    deviceKey(target) === filter.device;
  return app && device;
}

function noMatchingRuntime(
  runtimes: MetroInspectorTarget[],
  filter: RuntimeTargetFilter,
): AppError {
  const seen = runtimes.map(
    (target) => `${targetAppId(target)} on ${target.deviceName ?? deviceKey(target)}`,
  );
  return new AppError(
    'COMMAND_FAILED',
    filter.appId || filter.device
      ? 'No matching React Native runtime is connected to the dev server.'
      : 'No React Native runtime is connected to the dev server.',
    {
      hint:
        seen.length > 0
          ? `Connected runtimes: ${[...new Set(seen)].join(', ')}.`
          : 'Open the app from a development build so it loads its bundle from this dev server.',
    },
  );
}

/** The main runtime of each device: a device registers it before any secondary runtime. */
function mainRuntimePerDevice(candidates: MetroInspectorTarget[]): MetroInspectorTarget[] {
  const devices = new Map<string, MetroInspectorTarget>();
  for (const target of candidates) {
    const key = deviceKey(target);
    const current = devices.get(key);
    devices.set(key, current && pageNumber(current) <= pageNumber(target) ? current : target);
  }
  return [...devices.values()];
}

/** A value `--metro-device` matches uniquely: the device name, or its key when names collide. */
function deviceSelectors(devices: MetroInspectorTarget[]): string[] {
  const nameCounts = new Map<string, number>();
  for (const { deviceName } of devices) {
    if (deviceName) nameCounts.set(deviceName, (nameCounts.get(deviceName) ?? 0) + 1);
  }
  return devices.map((target) =>
    target.deviceName && nameCounts.get(target.deviceName) === 1
      ? target.deviceName
      : deviceKey(target),
  );
}

/**
 * Picks the one React Native runtime to profile. Pages without the `reactNative` field are not app
 * runtimes, and worklet runtimes render no React tree. Several apps or several devices fail
 * closed: the caller must narrow to exactly one runtime.
 */
export function selectReactNativeTarget(
  targets: MetroInspectorTarget[],
  filter: RuntimeTargetFilter = {},
): MetroInspectorTarget {
  const runtimes = targets.filter(isAppRuntime);
  const candidates = runtimes.filter((target) => matchesFilter(target, filter));
  if (candidates.length === 0) throw noMatchingRuntime(runtimes, filter);
  const apps = new Set(candidates.map(targetAppId));
  if (apps.size > 1) {
    throw new AppError(
      'INVALID_ARGS',
      'Several React Native apps are connected to the dev server.',
      {
        hint: `Pass --app with one of: ${[...apps].join(', ')}.`,
      },
    );
  }
  const devices = mainRuntimePerDevice(candidates);
  if (devices.length > 1) {
    throw new AppError(
      'INVALID_ARGS',
      'The app is connected to the dev server from several devices.',
      {
        hint: `Pass --metro-device with one of: ${deviceSelectors(devices).join(', ')}.`,
      },
    );
  }
  return devices[0]!;
}

/**
 * Node's WebSocket (undici) accepts an init object with request headers; the DOM typing this
 * repo compiles against only declares subprotocols.
 */
const WebSocketWithHeaders = WebSocket as unknown as new (
  url: URL,
  init: { headers: Record<string, string> },
) => WebSocket;

type PendingCall = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** Minimal Chrome DevTools Protocol client over the dev server's inspector proxy. */
export class InspectorSession {
  #nextId = 1;
  #pending = new Map<number, PendingCall>();
  readonly #socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => this.#onMessage(String(event.data)));
    socket.addEventListener('close', () => {
      for (const { reject } of this.#pending.values()) {
        reject(new AppError('COMMAND_FAILED', 'The app runtime closed the debugger connection.'));
      }
      this.#pending.clear();
    });
  }

  static async connect(webSocketDebuggerUrl: string): Promise<InspectorSession> {
    const url = new URL(webSocketDebuggerUrl);
    // Metro refuses debugger upgrades without a loopback Origin, and Expo's dev server terminates
    // any whose Origin host differs from its own 127.0.0.1:<port> base URL.
    const origin = `http://127.0.0.1:${url.port || (url.protocol === 'wss:' ? '443' : '80')}`;
    const socket = new WebSocketWithHeaders(url, { headers: { origin } });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new AppError('COMMAND_FAILED', 'Timed out connecting to the app runtime debugger.'));
      }, CONNECT_TIMEOUT_MS);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(
            new AppError(
              'COMMAND_FAILED',
              'The dev server refused the debugger connection to the app runtime.',
            ),
          );
        },
        { once: true },
      );
    });
    return new InspectorSession(socket);
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = (await this.#send('Runtime.evaluate', { expression, returnByValue: true })) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (result.exceptionDetails) {
      const { text, exception } = result.exceptionDetails;
      throw new AppError(
        'COMMAND_FAILED',
        'The profiler runtime threw inside the app.',
        undefined,
        exception?.description ?? text ?? 'unknown exception',
      );
    }
    return result.result?.value;
  }

  close(): void {
    this.#socket.close();
  }

  #send(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AppError('COMMAND_FAILED', `The app runtime did not answer ${method} in time.`));
      }, EVALUATE_TIMEOUT_MS);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  #onMessage(raw: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) {
      pending.reject(
        new AppError(
          'COMMAND_FAILED',
          `Debugger protocol error: ${message.error.message ?? 'unknown'}`,
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }
}

/**
 * The target's debugger socket on the server that listed it. Metro builds `webSocketDebuggerUrl`
 * from the Host header it received, and a bridge or tunnel in front of Metro shows it Metro's own
 * loopback address, which a caller on another machine cannot reach.
 */
export function debuggerUrlOn(serverUrl: URL, target: MetroInspectorTarget): string {
  const advertised = new URL(target.webSocketDebuggerUrl);
  const url = withTrailingSlash(serverUrl);
  url.protocol = serverUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${advertised.pathname}`;
  url.search = advertised.search;
  return url.toString();
}

function withTrailingSlash(url: URL): URL {
  const copy = new URL(url);
  if (!copy.pathname.endsWith('/')) copy.pathname = `${copy.pathname}/`;
  copy.search = '';
  copy.hash = '';
  return copy;
}
