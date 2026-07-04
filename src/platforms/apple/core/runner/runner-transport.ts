import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {
  createRequestCanceledError,
  isRequestCanceledError,
} from '../../../../daemon/request-cancel.ts';
import { AppError } from '../../../../kernel/errors.ts';
import { requireExecSuccess } from '../../../../utils/exec.ts';
import { Deadline, retryWithPolicy } from '../../../../utils/retry.ts';
import type { DeviceInfo } from '../../../../kernel/device.ts';
import { classifyBootFailure, bootFailureHint } from '../../../boot-diagnostics.ts';
import { buildSimctlArgsForDevice } from '../simctl.ts';
import { runXcrun } from '../tool-provider.ts';
import {
  buildRunnerConnectError,
  buildRunnerEarlyExitError,
  shouldRetryRunnerConnectError,
  type RunnerCommand,
} from './runner-contract.ts';
import type { RunnerSession } from './runner-session-types.ts';

export const RUNNER_STARTUP_TIMEOUT_MS = 45_000;
export const RUNNER_COMMAND_TIMEOUT_MS = 45_000;
const RUNNER_CONNECT_ATTEMPT_INTERVAL_MS = 250;
const RUNNER_CONNECT_RETRY_BASE_DELAY_MS = 300;
const RUNNER_CONNECT_RETRY_MAX_DELAY_MS = 2_000;
const RUNNER_CONNECT_REQUEST_TIMEOUT_MS = 20_000;
const RUNNER_DEVICE_INFO_TIMEOUT_MS = 10_000;
const RUNNER_DEVICE_TUNNEL_IP_CACHE_TTL_MS = 30_000;
export const RUNNER_DESTINATION_TIMEOUT_SECONDS = 20;

type DeviceTunnelIpCacheEntry = {
  ip: string;
  expiresAt: number;
};

const deviceTunnelIpCache = new Map<string, DeviceTunnelIpCacheEntry>();

export async function waitForRunner(
  device: DeviceInfo,
  port: number,
  command: RunnerCommand,
  logPath?: string,
  timeoutMs: number = RUNNER_STARTUP_TIMEOUT_MS,
  session?: RunnerSession,
  signal?: AbortSignal,
): Promise<Response> {
  const deadline = Deadline.fromTimeoutMs(timeoutMs);
  const { getEndpoints } = createRunnerEndpointResolver(device, port);
  let { endpoints } = await getEndpoints(deadline.remainingMs());
  let lastError: unknown = null;
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / RUNNER_CONNECT_ATTEMPT_INTERVAL_MS));
  try {
    return await retryWithPolicy(
      async ({ deadline: attemptDeadline }) => {
        const response = await attemptRunnerConnection({
          device,
          port,
          command,
          timeoutMs,
          logPath,
          session,
          endpoints,
          getEndpoints,
          signal,
          attemptDeadline,
          setEndpoints: (nextEndpoints) => {
            endpoints = nextEndpoints;
          },
          setLastError: (err) => {
            lastError = err;
          },
        });
        if (response) return response;
        throw buildRunnerEndpointProbeError({ port, endpoints, lastError, signal });
      },
      {
        maxAttempts,
        baseDelayMs: RUNNER_CONNECT_RETRY_BASE_DELAY_MS,
        maxDelayMs: RUNNER_CONNECT_RETRY_MAX_DELAY_MS,
        jitter: 0.2,
        shouldRetry: shouldRetryRunnerConnectError,
      },
      { deadline, phase: 'ios_runner_connect', signal },
    );
  } catch (error) {
    if (signal?.aborted || isRequestCanceledError(error)) {
      throw createRequestCanceledError();
    }
    if (!lastError) {
      lastError = error;
    }
  }

  if (signal?.aborted) {
    throw createRequestCanceledError();
  }

  if (device.kind === 'simulator') {
    const remainingMs = deadline.remainingMs();
    if (remainingMs <= 0) {
      throw buildRunnerConnectError({ port, endpoints, logPath, lastError });
    }
    const simResponse = await postCommandViaSimulator(device, port, command, remainingMs, signal);
    return new Response(simResponse.body, { status: simResponse.status });
  }

  throw buildRunnerConnectError({ port, endpoints, logPath, lastError });
}

type RunnerEndpointResolver = ReturnType<typeof createRunnerEndpointResolver>['getEndpoints'];

async function attemptRunnerConnection(params: {
  device: DeviceInfo;
  port: number;
  command: RunnerCommand;
  timeoutMs: number;
  logPath?: string;
  session?: RunnerSession;
  endpoints: string[];
  getEndpoints: RunnerEndpointResolver;
  signal?: AbortSignal;
  attemptDeadline?: Deadline;
  setEndpoints: (endpoints: string[]) => void;
  setLastError: (error: unknown) => void;
}): Promise<Response | null> {
  await ensureRunnerAttemptCanStart(params);

  const primary = await tryPrimaryRunnerEndpoints(params);
  if (primary.response) return primary.response;

  const simulatorFallback = await tryReadySimulatorEndpoint(params);
  if (simulatorFallback) return simulatorFallback;

  return await tryRefreshedDeviceTunnel(params, primary.usedCachedTunnelIp);
}

async function ensureRunnerAttemptCanStart(params: {
  port: number;
  timeoutMs: number;
  logPath?: string;
  session?: RunnerSession;
  attemptDeadline?: Deadline;
}): Promise<void> {
  if (params.attemptDeadline?.isExpired()) {
    throw new AppError('COMMAND_FAILED', 'Runner connection deadline exceeded', {
      port: params.port,
      timeoutMs: params.timeoutMs,
    });
  }
  if (params.session?.child.exitCode !== null && params.session?.child.exitCode !== undefined) {
    throw await buildRunnerEarlyExitError({
      session: params.session,
      port: params.port,
      logPath: params.logPath,
    });
  }
}

async function tryPrimaryRunnerEndpoints(params: {
  device: DeviceInfo;
  port: number;
  command: RunnerCommand;
  timeoutMs: number;
  endpoints: string[];
  getEndpoints: RunnerEndpointResolver;
  signal?: AbortSignal;
  attemptDeadline?: Deadline;
  setEndpoints: (endpoints: string[]) => void;
  setLastError: (error: unknown) => void;
}): Promise<{ response: Response | null; usedCachedTunnelIp: boolean }> {
  let endpoints = params.endpoints;
  let usedCachedTunnelIp = false;
  if (params.device.kind === 'device') {
    const resolved = await params.getEndpoints(params.attemptDeadline?.remainingMs());
    endpoints = resolved.endpoints;
    usedCachedTunnelIp = resolved.cached;
    params.setEndpoints(endpoints);
  }

  const cachedTunnelEndpoint = usedCachedTunnelIp ? endpoints[0] : null;
  const response = await tryRunnerEndpoints(endpoints, {
    command: params.command,
    port: params.port,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
    attemptDeadline: params.attemptDeadline,
    onError: (endpoint, err) => {
      params.setLastError(err);
      if (params.device.kind === 'device' && endpoint === cachedTunnelEndpoint) {
        invalidateDeviceTunnelIpCache(params.device.id);
      }
    },
  });
  return { response, usedCachedTunnelIp };
}

async function tryReadySimulatorEndpoint(params: {
  device: DeviceInfo;
  port: number;
  command: RunnerCommand;
  session?: RunnerSession;
  signal?: AbortSignal;
  attemptDeadline?: Deadline;
  setLastError: (error: unknown) => void;
}): Promise<Response | null> {
  if (params.device.kind !== 'simulator' || !params.session?.ready) return null;
  return await tryRunnerSimulatorEndpoint(params.device, params.port, params.command, {
    signal: params.signal,
    attemptDeadline: params.attemptDeadline,
    onError: params.setLastError,
  });
}

async function tryRefreshedDeviceTunnel(
  params: {
    device: DeviceInfo;
    port: number;
    command: RunnerCommand;
    timeoutMs: number;
    getEndpoints: RunnerEndpointResolver;
    signal?: AbortSignal;
    attemptDeadline?: Deadline;
    setEndpoints: (endpoints: string[]) => void;
    setLastError: (error: unknown) => void;
  },
  usedCachedTunnelIp: boolean,
): Promise<Response | null> {
  if (params.device.kind !== 'device' || !usedCachedTunnelIp) return null;
  invalidateDeviceTunnelIpCache(params.device.id);
  const refreshed = await params.getEndpoints(params.attemptDeadline?.remainingMs(), true);
  params.setEndpoints(refreshed.endpoints);
  return await tryRunnerEndpoints(refreshed.endpoints, {
    command: params.command,
    port: params.port,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
    attemptDeadline: params.attemptDeadline,
    onError: (_endpoint, err) => {
      params.setLastError(err);
    },
  });
}

function buildRunnerEndpointProbeError(params: {
  port: number;
  endpoints: string[];
  lastError: unknown;
  signal?: AbortSignal;
}): AppError {
  if (params.signal?.aborted) {
    throw createRequestCanceledError();
  }
  return new AppError('COMMAND_FAILED', 'Runner endpoint probe failed', {
    port: params.port,
    endpoints: params.endpoints,
    lastError: params.lastError ? String(params.lastError) : undefined,
  });
}

export async function sendRunnerCommandOnce(
  device: DeviceInfo,
  port: number,
  command: RunnerCommand,
  timeoutMs: number = RUNNER_COMMAND_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<Response> {
  if (signal?.aborted) {
    throw createRequestCanceledError();
  }
  const deadline = Deadline.fromTimeoutMs(timeoutMs);
  const { getEndpoints } = createRunnerEndpointResolver(device, port);
  const { endpoints } = await getEndpoints(deadline.remainingMs());
  const endpoint = endpoints[0];
  if (!endpoint) {
    throw new AppError('COMMAND_FAILED', 'Runner command endpoint not available', {
      port,
      endpoints,
    });
  }
  const remainingMs = deadline.remainingMs();
  if (remainingMs <= 0) {
    throw new AppError('COMMAND_FAILED', 'Runner command deadline exceeded', { timeoutMs });
  }
  return await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    },
    remainingMs,
    signal,
  );
}

function createRunnerEndpointResolver(device: DeviceInfo, port: number) {
  let requestTunnelIp: string | null | undefined;
  return {
    getEndpoints: async (timeoutBudgetMs?: number, forceRefresh = false) => {
      const tunnelIp = await getDeviceTunnelIpForRequest({
        device,
        timeoutBudgetMs,
        forceRefresh,
        requestTunnelIp,
        setRequestTunnelIp: (ip) => {
          requestTunnelIp = ip;
        },
      });
      return {
        endpoints: resolveRunnerCommandEndpoints(device, port, tunnelIp.ip),
        cached: tunnelIp.sharedCacheHit,
      };
    },
  };
}

async function tryRunnerEndpoints(
  endpoints: string[],
  params: {
    command: RunnerCommand;
    port: number;
    timeoutMs: number;
    signal?: AbortSignal;
    attemptDeadline?: Deadline;
    onError: (endpoint: string, error: unknown) => void;
  },
): Promise<Response | null> {
  const { command, port, timeoutMs, signal, attemptDeadline, onError } = params;
  for (const endpoint of endpoints) {
    try {
      const remainingMs = attemptDeadline?.remainingMs() ?? timeoutMs;
      if (remainingMs <= 0) {
        throw new AppError('COMMAND_FAILED', 'Runner connection deadline exceeded', {
          port,
          timeoutMs,
        });
      }
      return await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(command),
        },
        Math.min(RUNNER_CONNECT_REQUEST_TIMEOUT_MS, remainingMs),
        signal,
      );
    } catch (err) {
      if (signal?.aborted || isRequestCanceledError(err)) {
        throw createRequestCanceledError();
      }
      onError(endpoint, err);
    }
  }
  return null;
}

async function tryRunnerSimulatorEndpoint(
  device: DeviceInfo,
  port: number,
  command: RunnerCommand,
  params: {
    signal?: AbortSignal;
    attemptDeadline?: Deadline;
    onError: (error: unknown) => void;
  },
): Promise<Response | null> {
  const { signal, attemptDeadline, onError } = params;
  const remainingMs = attemptDeadline?.remainingMs() ?? RUNNER_COMMAND_TIMEOUT_MS;
  if (remainingMs <= 0) return null;
  try {
    const simResponse = await postCommandViaSimulator(device, port, command, remainingMs, signal);
    return new Response(simResponse.body, { status: simResponse.status });
  } catch (err) {
    if (signal?.aborted || isRequestCanceledError(err)) {
      throw createRequestCanceledError();
    }
    onError(err);
    return null;
  }
}

async function getDeviceTunnelIpForRequest(params: {
  device: DeviceInfo;
  timeoutBudgetMs?: number;
  forceRefresh: boolean;
  requestTunnelIp: string | null | undefined;
  setRequestTunnelIp: (ip: string | null) => void;
}): Promise<{ ip: string | null; sharedCacheHit: boolean }> {
  const { device, timeoutBudgetMs, forceRefresh, requestTunnelIp, setRequestTunnelIp } = params;
  if (device.kind !== 'device') {
    return { ip: null, sharedCacheHit: false };
  }
  if (!forceRefresh) {
    const cached = readDeviceTunnelIpCache(device.id);
    if (cached) return { ip: cached, sharedCacheHit: true };
    if (requestTunnelIp !== undefined) return { ip: requestTunnelIp, sharedCacheHit: false };
  }
  const ip = await resolveDeviceTunnelIp(device.id, timeoutBudgetMs);
  setRequestTunnelIp(ip);
  if (ip) writeDeviceTunnelIpCache(device.id, ip);
  return { ip, sharedCacheHit: false };
}

function readDeviceTunnelIpCache(deviceId: string): string | null {
  const cached = deviceTunnelIpCache.get(deviceId);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    deviceTunnelIpCache.delete(deviceId);
    return null;
  }
  return cached.ip;
}

function writeDeviceTunnelIpCache(deviceId: string, ip: string): void {
  deviceTunnelIpCache.set(deviceId, {
    ip,
    expiresAt: Date.now() + RUNNER_DEVICE_TUNNEL_IP_CACHE_TTL_MS,
  });
}

function invalidateDeviceTunnelIpCache(deviceId: string): void {
  deviceTunnelIpCache.delete(deviceId);
}

export function clearDeviceTunnelIpCache(): void {
  deviceTunnelIpCache.clear();
}

function resolveRunnerCommandEndpoints(
  device: DeviceInfo,
  port: number,
  tunnelIp: string | null,
): string[] {
  const endpoints = [`http://127.0.0.1:${port}/command`];
  if (device.kind !== 'device') {
    return endpoints;
  }
  if (tunnelIp) {
    endpoints.unshift(`http://[${tunnelIp}]:${port}/command`);
  }
  return endpoints;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  requestSignal?: AbortSignal,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = requestSignal ? AbortSignal.any([requestSignal, timeoutSignal]) : timeoutSignal;
  return await fetch(url, { ...init, signal });
}

async function resolveDeviceTunnelIp(
  deviceId: string,
  timeoutBudgetMs?: number,
): Promise<string | null> {
  if (typeof timeoutBudgetMs === 'number' && timeoutBudgetMs <= 0) {
    return null;
  }
  const timeoutMs =
    typeof timeoutBudgetMs === 'number'
      ? Math.max(1, Math.min(RUNNER_DEVICE_INFO_TIMEOUT_MS, timeoutBudgetMs))
      : RUNNER_DEVICE_INFO_TIMEOUT_MS;
  const jsonPath = path.join(
    os.tmpdir(),
    `agent-device-devicectl-info-${process.pid}-${Date.now()}.json`,
  );
  try {
    const devicectlTimeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const result = await runXcrun(
      [
        'devicectl',
        'device',
        'info',
        'details',
        '--device',
        deviceId,
        '--json-output',
        jsonPath,
        '--timeout',
        String(devicectlTimeoutSeconds),
      ],
      { allowFailure: true, timeoutMs },
    );
    if (result.exitCode !== 0 || !fs.existsSync(jsonPath)) {
      return null;
    }
    const payload = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as {
      info?: { outcome?: string };
      result?: {
        connectionProperties?: { tunnelIPAddress?: string };
        device?: { connectionProperties?: { tunnelIPAddress?: string } };
      };
    };
    if (payload.info?.outcome && payload.info.outcome !== 'success') {
      return null;
    }
    const ip = (
      payload.result?.connectionProperties?.tunnelIPAddress ??
      payload.result?.device?.connectionProperties?.tunnelIPAddress
    )?.trim();
    return ip && ip.length > 0 ? ip : null;
  } catch {
    return null;
  } finally {
    cleanupTempFile(jsonPath);
  }
}

async function postCommandViaSimulator(
  device: DeviceInfo,
  port: number,
  command: RunnerCommand,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(command);
  const args = buildSimctlArgsForDevice(device, [
    'spawn',
    device.id,
    '/usr/bin/curl',
    '-s',
    '-X',
    'POST',
    '-H',
    'Content-Type: application/json',
    '--data',
    payload,
    `http://127.0.0.1:${port}/command`,
  ]);
  const result = requireExecSuccess(
    await runXcrun(args, { allowFailure: true, timeoutMs, signal }),
    'Runner did not accept connection (simctl spawn)',
    (result) => {
      const reason = classifyBootFailure({
        message: 'Runner did not accept connection (simctl spawn)',
        stdout: result.stdout,
        stderr: result.stderr,
        context: { platform: 'ios', phase: 'connect' },
      });
      return {
        port,
        reason,
        hint: bootFailureHint(reason),
      };
    },
  );
  const body = result.stdout as string;
  return { status: 200, body };
}

export async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address?.port) {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new AppError('COMMAND_FAILED', 'Failed to allocate port')));
      }
    });
    server.on('error', reject);
  });
}

export function logChunk(
  chunk: string,
  logPath?: string,
  traceLogPath?: string,
  verbose?: boolean,
): void {
  if (logPath) appendLogChunk(logPath, chunk);
  if (traceLogPath) appendLogChunk(traceLogPath, chunk);
  if (verbose) {
    process.stderr.write(chunk);
  }
}

const logAppendQueues = new Map<string, Promise<void>>();

function appendLogChunk(logPath: string, chunk: string): void {
  const previous = logAppendQueues.get(logPath) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
      await fs.promises.appendFile(logPath, chunk);
    })
    .catch(() => {});
  const queued = next.finally(() => {
    if (logAppendQueues.get(logPath) === queued) {
      logAppendQueues.delete(logPath);
    }
  });
  logAppendQueues.set(logPath, queued);
}

export function cleanupTempFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}
