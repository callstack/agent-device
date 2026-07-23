import { createRequestCanceledError, isRequestCanceledError } from '../../../../request/cancel.ts';
import { AppError } from '../../../../kernel/errors.ts';
import { requireExecSuccess } from '../../../../utils/exec.ts';
import { Deadline, retryWithPolicy } from '../../../../utils/retry.ts';
import type { DeviceInfo } from '../../../../kernel/device.ts';
import { classifyBootFailure, bootFailureHint } from '../../../boot-diagnostics.ts';
import { buildSimctlArgsForDevice } from '../simctl.ts';
import { runXcrun } from '../tool-provider.ts';
import {
  createRunnerCommandRouteResolver,
  invalidateDeviceTunnelIpCache,
  type RunnerCommandRoute,
} from './runner-command-route.ts';
import {
  buildRunnerConnectError,
  buildRunnerEarlyExitError,
  shouldRetryRunnerConnectError,
  type RunnerCommand,
} from './runner-contract.ts';
import type { RunnerSession } from './runner-session-types.ts';
import { usbmuxRunnerTransport } from './runner-usbmux.ts';

export { cleanupTempFile, getFreePort, logChunk } from './runner-io.ts';

export const RUNNER_STARTUP_TIMEOUT_MS = 45_000;
export const RUNNER_COMMAND_TIMEOUT_MS = 45_000;
const RUNNER_CONNECT_ATTEMPT_INTERVAL_MS = 250;
const RUNNER_CONNECT_RETRY_BASE_DELAY_MS = 300;
const RUNNER_CONNECT_RETRY_MAX_DELAY_MS = 2_000;
const RUNNER_CONNECT_REQUEST_TIMEOUT_MS = 20_000;
export const RUNNER_DESTINATION_TIMEOUT_SECONDS = 20;

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
  const { resolveRoute } = createRunnerCommandRouteResolver(device, port);
  let route = await resolveRoute(deadline.remainingMs());
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
          route,
          resolveRoute,
          signal,
          attemptDeadline,
          setRoute: (nextRoute) => {
            route = nextRoute;
          },
          setLastError: (err) => {
            lastError = err;
          },
        });
        if (response) return response;
        throw buildRunnerEndpointProbeError({
          port,
          endpoints: route.endpoints,
          lastError,
          signal,
        });
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
      throw buildRunnerConnectError({ port, endpoints: route.endpoints, logPath, lastError });
    }
    const simResponse = await postCommandViaSimulator(device, port, command, remainingMs, signal);
    return new Response(simResponse.body, { status: simResponse.status });
  }

  throw buildRunnerConnectError({ port, endpoints: route.endpoints, logPath, lastError });
}

type RunnerRouteResolver = ReturnType<typeof createRunnerCommandRouteResolver>['resolveRoute'];

async function attemptRunnerConnection(params: {
  device: DeviceInfo;
  port: number;
  command: RunnerCommand;
  timeoutMs: number;
  logPath?: string;
  session?: RunnerSession;
  route: RunnerCommandRoute;
  resolveRoute: RunnerRouteResolver;
  signal?: AbortSignal;
  attemptDeadline?: Deadline;
  setRoute: (route: RunnerCommandRoute) => void;
  setLastError: (error: unknown) => void;
}): Promise<Response | null> {
  await ensureRunnerAttemptCanStart(params);

  const primary = await tryPrimaryRunnerRoute(params);
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

async function tryPrimaryRunnerRoute(params: {
  device: DeviceInfo;
  port: number;
  command: RunnerCommand;
  timeoutMs: number;
  route: RunnerCommandRoute;
  resolveRoute: RunnerRouteResolver;
  signal?: AbortSignal;
  attemptDeadline?: Deadline;
  setRoute: (route: RunnerCommandRoute) => void;
  setLastError: (error: unknown) => void;
}): Promise<{ response: Response | null; usedCachedTunnelIp: boolean }> {
  let route = params.route;
  let usedCachedTunnelIp = false;
  if (params.device.kind === 'device') {
    route = await params.resolveRoute(params.attemptDeadline?.remainingMs());
    usedCachedTunnelIp = route.cachedTunnelIp;
    params.setRoute(route);
  }

  const cachedTunnelEndpoint = usedCachedTunnelIp ? route.endpoints[0] : null;
  const response = await tryRunnerRoute(params.device, route, {
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
    resolveRoute: RunnerRouteResolver;
    signal?: AbortSignal;
    attemptDeadline?: Deadline;
    setRoute: (route: RunnerCommandRoute) => void;
    setLastError: (error: unknown) => void;
  },
  usedCachedTunnelIp: boolean,
): Promise<Response | null> {
  if (params.device.kind !== 'device' || !usedCachedTunnelIp) return null;
  invalidateDeviceTunnelIpCache(params.device.id);
  const refreshed = await params.resolveRoute(params.attemptDeadline?.remainingMs(), true);
  params.setRoute(refreshed);
  return await tryRunnerRoute(params.device, refreshed, {
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
  const { resolveRoute } = createRunnerCommandRouteResolver(device, port);
  const route = await resolveRoute(deadline.remainingMs());
  const remainingMs = deadline.remainingMs();
  if (remainingMs <= 0) {
    throw new AppError('COMMAND_FAILED', 'Runner command deadline exceeded', { timeoutMs });
  }
  if (route.kind === 'usbmux') {
    return await usbmuxRunnerTransport.postCommand(device.id, port, command, remainingMs, signal);
  }
  const endpoint = route.endpoints[0];
  if (!endpoint) {
    throw new AppError('COMMAND_FAILED', 'Runner command endpoint not available', {
      port,
      endpoints: route.endpoints,
    });
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

async function tryRunnerRoute(
  device: DeviceInfo,
  route: RunnerCommandRoute,
  params: {
    command: RunnerCommand;
    port: number;
    timeoutMs: number;
    signal?: AbortSignal;
    attemptDeadline?: Deadline;
    onError: (endpoint: string, error: unknown) => void;
  },
): Promise<Response | null> {
  if (route.kind === 'network') {
    return await tryRunnerEndpoints(route.endpoints, params);
  }
  const endpoint = route.endpoints[0];
  try {
    const remainingMs = params.attemptDeadline?.remainingMs() ?? params.timeoutMs;
    if (remainingMs <= 0) {
      throw new AppError('COMMAND_FAILED', 'Runner connection deadline exceeded', {
        port: params.port,
        timeoutMs: params.timeoutMs,
      });
    }
    return await usbmuxRunnerTransport.postCommand(
      device.id,
      params.port,
      params.command,
      Math.min(RUNNER_CONNECT_REQUEST_TIMEOUT_MS, remainingMs),
      params.signal,
    );
  } catch (error) {
    if (params.signal?.aborted || isRequestCanceledError(error)) {
      throw createRequestCanceledError();
    }
    params.onError(endpoint, error);
    return null;
  }
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
