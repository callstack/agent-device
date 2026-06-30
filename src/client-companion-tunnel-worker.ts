import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import {
  COMPANION_TUNNEL_LEASE_CHECK_INTERVAL_MS,
  COMPANION_TUNNEL_RECONNECT_DELAY_MS,
  ENV_COMPANION_TUNNEL_BEARER_TOKEN,
  ENV_COMPANION_TUNNEL_DEVICE_PORT,
  ENV_COMPANION_TUNNEL_LAUNCH_URL,
  ENV_COMPANION_TUNNEL_LOCAL_BASE_URL,
  ENV_COMPANION_TUNNEL_REGISTER_PATH,
  ENV_COMPANION_TUNNEL_SCOPE_LEASE_ID,
  ENV_COMPANION_TUNNEL_SCOPE_RUN_ID,
  ENV_COMPANION_TUNNEL_SCOPE_TENANT_ID,
  ENV_COMPANION_TUNNEL_SERVER_BASE_URL,
  ENV_COMPANION_TUNNEL_SESSION,
  ENV_COMPANION_TUNNEL_STATE_PATH,
  ENV_COMPANION_TUNNEL_UNREGISTER_PATH,
  METRO_COMPANION_RUN_ARG,
  REACT_DEVTOOLS_COMPANION_RUN_ARG,
  WS_READY_STATE_OPEN,
  MissingCompanionEnvError,
  type CompanionTunnelWorkerOptions,
} from './client-companion-tunnel-contract.ts';
import type {
  MetroTunnelRequestMessage as MetroCompanionRequest,
  MetroTunnelResponseMessage,
} from './metro/metro.ts';
import { normalizeBaseUrl } from './utils/url.ts';

const COMPANION_REGISTER_TIMEOUT_MS = 5_000;
const COMPANION_REGISTER_MAX_RETRY_DELAY_MS = 60_000;

export type CompanionTunnelWorkerRuntime = {
  delay?: (ms: number) => Promise<void>;
  exit?: (code: number) => void;
  leaseCheckIntervalMs?: number;
  reconnectDelayMs?: number;
  registerProcessSignals?: boolean;
};

class CompanionRegistrationError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryable: boolean, retryAfterMs?: number) {
    super(message);
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

function createHeaders(serverBaseUrl: string, token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    ...(serverBaseUrl.includes('ngrok') ? { 'ngrok-skip-browser-warning': '1' } : {}),
  };
}

function formatResponseSnippet(text: string): string {
  const normalized = text.replaceAll(/\s+/g, ' ').trim();
  return normalized.length > 300 ? `${normalized.slice(0, 300)}...` : normalized;
}

function resolveRegisterPath(options: CompanionTunnelWorkerOptions): string {
  return options.registerPath;
}

function resolveUnregisterPath(options: CompanionTunnelWorkerOptions): string | null {
  return options.unregisterPath ?? null;
}

export function buildCompanionPayload(
  options: CompanionTunnelWorkerOptions,
): Record<string, unknown> {
  return {
    ...options.bridgeScope,
    ...(options.session ? { session: options.session } : {}),
    local_base_url: normalizeBaseUrl(options.localBaseUrl),
    ...(options.devicePort ? { device_port: options.devicePort } : {}),
    ...(options.launchUrl ? { launch_url: options.launchUrl } : {}),
  };
}

async function registerCompanion(
  options: CompanionTunnelWorkerOptions,
): Promise<{ wsUrl: string }> {
  const registerPath = resolveRegisterPath(options);
  let response: Response;
  try {
    response = await fetch(`${normalizeBaseUrl(options.serverBaseUrl)}${registerPath}`, {
      method: 'POST',
      headers: createHeaders(options.serverBaseUrl, options.bearerToken),
      body: JSON.stringify(buildCompanionPayload(options)),
      signal: AbortSignal.timeout(COMPANION_REGISTER_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(
        `${registerPath} timed out after ${COMPANION_REGISTER_TIMEOUT_MS}ms calling ${normalizeBaseUrl(
          options.serverBaseUrl,
        )}${registerPath}`,
      );
    }
    throw error;
  }
  const responseText = await response.text();
  let payload: {
    ok?: boolean;
    data?: { ws_url?: string };
    error?: { code?: string; details?: { retryAfterMs?: unknown } };
  };
  try {
    payload = responseText ? (JSON.parse(responseText) as typeof payload) : {};
  } catch {
    throw new CompanionRegistrationError(
      `Failed to register companion (${response.status}): invalid JSON response: ${formatResponseSnippet(
        responseText,
      )}`,
      isRetryableRegisterFailure(response.status, undefined),
      retryDelayFromResponse(response, {}),
    );
  }
  if (!response.ok || payload.ok !== true || typeof payload.data?.ws_url !== 'string') {
    throw new CompanionRegistrationError(
      `Failed to register companion (${response.status}): ${JSON.stringify(payload)}`,
      isRetryableRegisterFailure(response.status, payload.error?.code),
      retryDelayFromResponse(response, payload),
    );
  }
  return { wsUrl: payload.data.ws_url };
}

function isRetryableRegisterFailure(status: number, code: string | undefined): boolean {
  if (code === 'RATE_LIMITED') return true;
  if (code === 'UNAUTHORIZED' || code === 'INVALID_ARGS' || code === 'SESSION_NOT_FOUND') {
    return false;
  }
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function retryDelayFromResponse(
  response: Response,
  payload: { error?: { details?: { retryAfterMs?: unknown } } },
): number | undefined {
  const detailRetryAfter = payload.error?.details?.retryAfterMs;
  if (typeof detailRetryAfter === 'number' && Number.isFinite(detailRetryAfter)) {
    return clampRetryDelay(detailRetryAfter);
  }
  const retryAfter = response.headers.get('retry-after');
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) {
    return clampRetryDelay(seconds * 1000);
  }
  const retryAt = Date.parse(retryAfter);
  if (Number.isFinite(retryAt)) {
    return clampRetryDelay(retryAt - Date.now());
  }
  return undefined;
}

function clampRetryDelay(delayMs: number): number {
  return Math.max(0, Math.min(COMPANION_REGISTER_MAX_RETRY_DELAY_MS, Math.ceil(delayMs)));
}

function nextRetryDelay(currentDelayMs: number): number {
  return Math.min(currentDelayMs * 2, COMPANION_REGISTER_MAX_RETRY_DELAY_MS);
}

async function unregisterCompanion(options: CompanionTunnelWorkerOptions): Promise<void> {
  const unregisterPath = resolveUnregisterPath(options);
  if (!unregisterPath) return;
  try {
    await fetch(`${normalizeBaseUrl(options.serverBaseUrl)}${unregisterPath}`, {
      method: 'POST',
      headers: createHeaders(options.serverBaseUrl, options.bearerToken),
      body: JSON.stringify(buildCompanionPayload(options)),
      signal: AbortSignal.timeout(2_000),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
}

async function bufferFromWebSocketData(data: unknown): Promise<Buffer> {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return Buffer.from(await data.arrayBuffer());
  }
  return Buffer.from(String(data), 'utf8');
}

async function parseBridgeMessage(event: MessageEvent): Promise<MetroCompanionRequest> {
  const text = (await bufferFromWebSocketData(event.data)).toString('utf8');
  return JSON.parse(text) as MetroCompanionRequest;
}

function toUpstreamWebSocketUrl(localBaseUrl: string, requestPath: string): string {
  const upstream = new URL(requestPath, `${normalizeBaseUrl(localBaseUrl)}/`);
  upstream.protocol = upstream.protocol === 'https:' ? 'wss:' : 'ws:';
  return upstream.toString();
}

function normalizeCloseCode(code: number | undefined): number {
  if (typeof code !== 'number' || !Number.isInteger(code)) return 1011;
  if (code === 1000) return code;
  if (code >= 3000 && code <= 4999) return code;
  if (code >= 1001 && code <= 1015 && code !== 1004 && code !== 1005 && code !== 1006) {
    return code;
  }
  return 1011;
}

function normalizeOutgoingCloseCode(code: number): number {
  if (code === 1000) return code;
  if (code >= 3000 && code <= 4999) return code;
  return 3001;
}

function sendJson(socket: WebSocket, payload: MetroTunnelResponseMessage): void {
  if (socket.readyState !== WS_READY_STATE_OPEN) return;
  socket.send(JSON.stringify(payload));
}

async function waitForSocketOpen(socket: WebSocket, label: string): Promise<void> {
  if (socket.readyState === WS_READY_STATE_OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error(`${label} WebSocket failed before opening.`));
    };
    const handleClose = () => {
      cleanup();
      reject(new Error(`${label} WebSocket closed before opening.`));
    };
    const cleanup = () => {
      socket.removeEventListener('open', handleOpen);
      socket.removeEventListener('error', handleError);
      socket.removeEventListener('close', handleClose);
    };
    socket.addEventListener('open', handleOpen, { once: true });
    socket.addEventListener('error', handleError, { once: true });
    socket.addEventListener('close', handleClose, { once: true });
  });
}

async function waitForSocketShutdown(socket: WebSocket): Promise<void> {
  if (socket.readyState >= WebSocket.CLOSING) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      socket.removeEventListener('close', finish);
      socket.removeEventListener('error', finish);
    };
    socket.addEventListener('close', finish, { once: true });
    socket.addEventListener('error', finish, { once: true });
    if (socket.readyState >= WebSocket.CLOSING) {
      finish();
    }
  });
}

function closeSocketQuietly(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(normalizeOutgoingCloseCode(code), reason);
  } catch {
    // ignore shutdown races
  }
}

function shouldKeepWorkerRunning(options: CompanionTunnelWorkerOptions): boolean {
  return !options.statePath || fs.existsSync(options.statePath);
}

async function handleBridgeHttpRequest(
  bridgeSocket: WebSocket,
  message: Extract<MetroCompanionRequest, { type: 'http-request' }>,
  options: CompanionTunnelWorkerOptions,
): Promise<void> {
  try {
    const response = await fetch(
      new URL(message.path, `${normalizeBaseUrl(options.localBaseUrl)}/`),
      {
        method: message.method,
        headers: message.headers,
        ...(message.bodyBase64 ? { body: Buffer.from(message.bodyBase64, 'base64') } : {}),
      },
    );
    const body = Buffer.from(await response.arrayBuffer());
    sendJson(bridgeSocket, {
      type: 'http-response',
      requestId: message.requestId,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      ...(body.length > 0 ? { bodyBase64: body.toString('base64') } : {}),
    });
  } catch (error) {
    sendJson(bridgeSocket, {
      type: 'http-error',
      requestId: message.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleBridgeWebSocketOpen(
  bridgeSocket: WebSocket,
  message: Extract<MetroCompanionRequest, { type: 'ws-open' }>,
  options: CompanionTunnelWorkerOptions,
  upstreamSockets: Map<string, WebSocket>,
): Promise<void> {
  const upstreamSocket = new WebSocket(toUpstreamWebSocketUrl(options.localBaseUrl, message.path));
  upstreamSocket.binaryType = 'arraybuffer';
  let opened = false;
  upstreamSocket.addEventListener('message', (event) => {
    void (async () => {
      if (!opened) return;
      const payload = await bufferFromWebSocketData(event.data);
      sendJson(bridgeSocket, {
        type: 'ws-frame',
        streamId: message.streamId,
        dataBase64: payload.toString('base64'),
        binary: typeof event.data !== 'string',
      });
    })().catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
    });
  });
  upstreamSocket.addEventListener('close', (event) => {
    upstreamSockets.delete(message.streamId);
    if (!opened) return;
    sendJson(bridgeSocket, {
      type: 'ws-close',
      streamId: message.streamId,
      code: event.code,
      reason: event.reason,
    });
  });
  upstreamSocket.addEventListener('error', () => {
    if (!opened) return;
    sendJson(bridgeSocket, {
      type: 'ws-close',
      streamId: message.streamId,
      code: 1011,
      reason: 'Upstream WebSocket error.',
    });
  });
  upstreamSockets.set(message.streamId, upstreamSocket);
  try {
    await waitForSocketOpen(upstreamSocket, 'Upstream');
    opened = true;
    sendJson(bridgeSocket, {
      type: 'ws-open-result',
      streamId: message.streamId,
      success: true,
      headers: {},
    });
  } catch (error) {
    upstreamSockets.delete(message.streamId);
    closeSocketQuietly(upstreamSocket, 1011, 'open failed');
    sendJson(bridgeSocket, {
      type: 'ws-open-result',
      streamId: message.streamId,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function handleBridgeWebSocketFrame(
  message: Extract<MetroCompanionRequest, { type: 'ws-frame' }>,
  upstreamSockets: Map<string, WebSocket>,
): void {
  const upstreamSocket = upstreamSockets.get(message.streamId);
  if (!upstreamSocket || upstreamSocket.readyState !== WS_READY_STATE_OPEN) return;
  const payload = Buffer.from(message.dataBase64, 'base64');
  upstreamSocket.send(message.binary ? payload : payload.toString('utf8'));
}

function handleBridgeWebSocketClose(
  message: Extract<MetroCompanionRequest, { type: 'ws-close' }>,
  upstreamSockets: Map<string, WebSocket>,
): void {
  const upstreamSocket = upstreamSockets.get(message.streamId);
  if (!upstreamSocket) return;
  upstreamSockets.delete(message.streamId);
  closeSocketQuietly(
    upstreamSocket,
    normalizeCloseCode(message.code),
    message.reason ?? 'bridge requested close',
  );
}

async function handleBridgeMessage(
  bridgeSocket: WebSocket,
  message: MetroCompanionRequest,
  options: CompanionTunnelWorkerOptions,
  upstreamSockets: Map<string, WebSocket>,
): Promise<void> {
  switch (message.type) {
    case 'ping': {
      sendJson(bridgeSocket, { type: 'pong', timestamp: message.timestamp });
      return;
    }
    case 'http-request': {
      await handleBridgeHttpRequest(bridgeSocket, message, options);
      return;
    }
    case 'ws-open': {
      await handleBridgeWebSocketOpen(bridgeSocket, message, options, upstreamSockets);
      return;
    }
    case 'ws-frame': {
      handleBridgeWebSocketFrame(message, upstreamSockets);
      return;
    }
    case 'ws-close': {
      handleBridgeWebSocketClose(message, upstreamSockets);
      return;
    }
  }
}

export async function runCompanionTunnelWorker(
  options: CompanionTunnelWorkerOptions,
  runtime: CompanionTunnelWorkerRuntime = {},
): Promise<void> {
  const upstreamSockets = new Map<string, WebSocket>();
  let shutdownRequested = false;
  let activeBridgeSocket: WebSocket | null = null;
  let activeRegistrationComplete = false;
  let activeUnregister: Promise<void> | null = null;
  const runtimeDelay = runtime.delay ?? delay;
  let resolveShutdownRequested!: () => void;
  const shutdownRequestedPromise = new Promise<void>((resolve) => {
    resolveShutdownRequested = resolve;
  });
  const exitWorker = () => {
    runtime.exit?.(0);
  };
  const unregisterActiveRegistration = async () => {
    if (!activeRegistrationComplete && !activeUnregister) return;
    activeUnregister ??= unregisterCompanion(options).finally(() => {
      activeRegistrationComplete = false;
      activeUnregister = null;
    });
    await activeUnregister;
  };
  const requestShutdown = () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    resolveShutdownRequested();
    if (activeRegistrationComplete) {
      void unregisterActiveRegistration().finally(exitWorker);
    }
    if (activeBridgeSocket) {
      closeSocketQuietly(activeBridgeSocket, 1000, 'companion stopping');
    }
    if (runtime.exit) {
      setTimeout(exitWorker, 900).unref();
    }
  };
  if (runtime.registerProcessSignals) {
    process.once('SIGTERM', requestShutdown);
    process.once('SIGINT', requestShutdown);
  }
  const lifetimeHandle = setInterval(() => {
    if (!shouldKeepWorkerRunning(options)) {
      // Node's built-in WebSocket client does not expose a force-close API. If the peer never
      // answers the close handshake, a detached worker can linger indefinitely, so lease expiry
      // uses a hard exit to guarantee teardown.
      requestShutdown();
      exitWorker();
    }
  }, runtime.leaseCheckIntervalMs ?? COMPANION_TUNNEL_LEASE_CHECK_INTERVAL_MS);
  lifetimeHandle.unref();
  let registerRetryDelayMs = runtime.reconnectDelayMs ?? COMPANION_TUNNEL_RECONNECT_DELAY_MS;
  try {
    while (!shutdownRequested && shouldKeepWorkerRunning(options)) {
      let registered = false;
      let retryDelayOverrideMs: number | undefined;
      try {
        activeRegistrationComplete = false;
        const registration = await registerCompanion(options);
        registerRetryDelayMs = runtime.reconnectDelayMs ?? COMPANION_TUNNEL_RECONNECT_DELAY_MS;
        registered = true;
        activeRegistrationComplete = true;
        if (shutdownRequested || !shouldKeepWorkerRunning(options)) {
          await unregisterActiveRegistration();
          registered = false;
          break;
        }
        const bridgeSocket = new WebSocket(registration.wsUrl);
        activeBridgeSocket = bridgeSocket;
        bridgeSocket.binaryType = 'arraybuffer';
        try {
          await waitForSocketOpen(bridgeSocket, 'Bridge');
          bridgeSocket.addEventListener('message', (event) => {
            void (async () => {
              const message = await parseBridgeMessage(event);
              await handleBridgeMessage(bridgeSocket, message, options, upstreamSockets);
            })().catch((error) => {
              console.error(error instanceof Error ? error.message : String(error));
            });
          });
          await Promise.race([waitForSocketShutdown(bridgeSocket), shutdownRequestedPromise]);
        } finally {
          activeBridgeSocket = null;
          upstreamSockets.forEach((socket) =>
            closeSocketQuietly(socket, 1012, 'bridge disconnected'),
          );
          upstreamSockets.clear();
          if (registered) {
            await unregisterActiveRegistration();
            registered = false;
          }
        }
      } catch (error) {
        activeBridgeSocket = null;
        if (registered) {
          await unregisterActiveRegistration();
          registered = false;
        }
        if (shutdownRequested || !shouldKeepWorkerRunning(options)) {
          break;
        }
        console.error(error instanceof Error ? error.message : String(error));
        if (error instanceof CompanionRegistrationError && !error.retryable) {
          break;
        }
        retryDelayOverrideMs =
          error instanceof CompanionRegistrationError ? error.retryAfterMs : undefined;
      }
      if (shutdownRequested || !shouldKeepWorkerRunning(options)) {
        break;
      }
      const delayMs = retryDelayOverrideMs ?? registerRetryDelayMs;
      if (retryDelayOverrideMs === undefined) {
        registerRetryDelayMs = nextRetryDelay(registerRetryDelayMs);
      }
      await runtimeDelay(delayMs);
    }
  } finally {
    clearInterval(lifetimeHandle);
    if (runtime.registerProcessSignals) {
      process.off('SIGTERM', requestShutdown);
      process.off('SIGINT', requestShutdown);
    }
  }
}

function parseDevicePort(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error('Companion worker received invalid device port configuration.');
  }
  return parsed;
}

function readWorkerOptions(
  argv: string[],
  env: NodeJS.ProcessEnv,
): CompanionTunnelWorkerOptions | null {
  const commandArg = argv[0];
  if (commandArg !== METRO_COMPANION_RUN_ARG && commandArg !== REACT_DEVTOOLS_COMPANION_RUN_ARG) {
    return null;
  }
  const serverBaseUrl = env[ENV_COMPANION_TUNNEL_SERVER_BASE_URL]?.trim();
  const bearerToken = env[ENV_COMPANION_TUNNEL_BEARER_TOKEN]?.trim();
  const localBaseUrl = env[ENV_COMPANION_TUNNEL_LOCAL_BASE_URL]?.trim();
  if (!serverBaseUrl || !bearerToken || !localBaseUrl) {
    throw new MissingCompanionEnvError(
      'Companion tunnel worker is missing required environment configuration.',
    );
  }
  const tenantId = env[ENV_COMPANION_TUNNEL_SCOPE_TENANT_ID]?.trim();
  const runId = env[ENV_COMPANION_TUNNEL_SCOPE_RUN_ID]?.trim();
  const leaseId = env[ENV_COMPANION_TUNNEL_SCOPE_LEASE_ID]?.trim();
  if (!tenantId || !runId || !leaseId) {
    throw new MissingCompanionEnvError(
      'Companion tunnel worker is missing required bridge scope configuration.',
    );
  }
  const registerPath = env[ENV_COMPANION_TUNNEL_REGISTER_PATH]?.trim();
  if (!registerPath) {
    throw new MissingCompanionEnvError(
      'Companion tunnel worker is missing required register path configuration.',
    );
  }
  return {
    serverBaseUrl,
    bearerToken,
    localBaseUrl,
    registerPath,
    bridgeScope: {
      tenantId,
      runId,
      leaseId,
    },
    launchUrl: env[ENV_COMPANION_TUNNEL_LAUNCH_URL]?.trim(),
    statePath: env[ENV_COMPANION_TUNNEL_STATE_PATH]?.trim(),
    unregisterPath: env[ENV_COMPANION_TUNNEL_UNREGISTER_PATH]?.trim(),
    devicePort: parseDevicePort(env[ENV_COMPANION_TUNNEL_DEVICE_PORT]?.trim()),
    session: env[ENV_COMPANION_TUNNEL_SESSION]?.trim(),
  };
}

export async function runCompanionTunnelProcessFromEnv(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const options = readWorkerOptions(argv, env);
  if (!options) return false;
  await runCompanionTunnelWorker(options, {
    exit: (code) => process.exit(code),
    registerProcessSignals: true,
  });
  return true;
}
