import {
  createRequestCanceledError,
  isRequestCanceledError,
  AppError,
} from '@agent-device/kernel/errors';
import {
  requireExecSuccess,
  Deadline,
  retryWithPolicy,
  classifyBootFailure,
  bootFailureHint,
  buildSimctlArgsForDevice,
  runXcrun,
} from './host.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { BootFailureReason } from '@agent-device/provision-kit/boot-diagnostics';
import {
  createRunnerCommandRouteResolver,
  invalidateDeviceTunnelIpCache,
  type RunnerCommandRoute,
} from './runner-command-route.ts';
import {
  classifyRunnerStartupFailure,
  enrichRunnerStartupFailureWithDeviceStates,
  isUsbmuxDeviceUnattachedError,
  RUNNER_CACHE_RECOVERY_HINT,
  runnerConnectFailureDetails,
  shouldRetryRunnerConnectError,
  type IosRunnerDeviceStates,
} from './runner-error-classification.ts';
import type { RunnerCommand } from './runner-contract.ts';
import type { RunnerSession } from './runner-session-types.ts';
import {
  runnerSimulatorSetFailureDetails,
  simulatorSetDestinationNotFoundMessage,
} from './runner-device-set.ts';
import {
  canFallBackFromUsbmux,
  fetchWithTimeout,
  RUNNER_COMMAND_TIMEOUT_MS,
} from './runner-transport.ts';
import { usbmuxRunnerTransport } from './runner-usbmux.ts';

export const RUNNER_STARTUP_TIMEOUT_MS = 45_000;
const RUNNER_CONNECT_ATTEMPT_INTERVAL_MS = 250;
const RUNNER_CONNECT_RETRY_BASE_DELAY_MS = 300;
const RUNNER_CONNECT_RETRY_MAX_DELAY_MS = 2_000;
const RUNNER_CONNECT_REQUEST_TIMEOUT_MS = 20_000;

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
  const { resolveRoute, markUsbmuxUnattached } = createRunnerCommandRouteResolver(device, port);
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
          markUsbmuxUnattached,
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
      {
        deadline,
        phase: 'ios_runner_connect',
        signal,
        retryWakeSignal: device.kind === 'simulator' ? session?.startupRetryWake : undefined,
      },
    );
  } catch (error) {
    if (signal?.aborted || isRequestCanceledError(error)) {
      throw createRequestCanceledError();
    }
    if (isUsbmuxDeviceUnattachedError(error)) throw error;
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

  if (session?.child.exitCode !== null && session?.child.exitCode !== undefined) {
    throw await buildRunnerEarlyExitError({ session, port, logPath });
  }
  throw buildRunnerConnectError({
    port,
    endpoints: route.endpoints,
    logPath,
    lastError,
    deviceStates: session?.startupDeviceStates,
  });
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
  markUsbmuxUnattached: () => void;
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
  markUsbmuxUnattached: () => void;
}): Promise<{ response: Response | null; usedCachedTunnelIp: boolean }> {
  let route = params.route;
  let usedCachedTunnelIp = false;
  if (params.device.kind === 'device') {
    route = await params.resolveRoute(params.attemptDeadline?.remainingMs());
    usedCachedTunnelIp = route.cachedTunnelIp;
    params.setRoute(route);
  }

  const runRoute = async (current: RunnerCommandRoute) => {
    // Derived per route: a usbmux-first attempt only learns its cached tunnel
    // endpoint after falling back, and a stale one must still be invalidated.
    const cachedTunnelEndpoint = current.cachedTunnelIp ? current.endpoints[0] : null;
    return await tryRunnerRoute(params.device, current, {
      command: params.command,
      port: params.port,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
      attemptDeadline: params.attemptDeadline,
      onUsbmuxUnattached: params.markUsbmuxUnattached,
      onError: (endpoint, err) => {
        params.setLastError(err);
        if (params.device.kind === 'device' && endpoint === cachedTunnelEndpoint) {
          invalidateDeviceTunnelIpCache(params.device.id);
        }
      },
    });
  };

  const response = await runRoute(route);
  if (response || route.kind !== 'usbmux') return { response, usedCachedTunnelIp };

  // usbmux reported the device as unattached: resolve the CoreDevice tunnel
  // route and try it within the same attempt instead of burning a retry.
  const fallback = await params.resolveRoute(params.attemptDeadline?.remainingMs());
  if (fallback.kind === 'usbmux') return { response: null, usedCachedTunnelIp };
  params.setRoute(fallback);
  return { response: await runRoute(fallback), usedCachedTunnelIp: fallback.cachedTunnelIp };
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
  if (params.device.kind !== 'simulator' || params.session?.state !== 'ready') return null;
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
    ...runnerConnectFailureDetails('runner_endpoint_probe_exhausted'),
  });
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
    onUsbmuxUnattached?: () => void;
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
    if (isUsbmuxDeviceUnattachedError(error)) {
      if (!canFallBackFromUsbmux(device, error)) {
        // No tunnel exists for this device, so retrying cannot attach a cable.
        // Throw the typed verdict so its recovery hint survives instead of
        // being replaced by a generic connect failure.
        throw error;
      }
      params.onUsbmuxUnattached?.();
      return null;
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
    } catch (error) {
      if (signal?.aborted || isRequestCanceledError(error)) {
        throw createRequestCanceledError();
      }
      onError(endpoint, error);
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
  } catch (error) {
    if (signal?.aborted || isRequestCanceledError(error)) {
      throw createRequestCanceledError();
    }
    onError(error);
    return null;
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
        ...runnerConnectFailureDetails('runner_connect_refused'),
      };
    },
  );
  const body = result.stdout as string;
  return { status: 200, body };
}

// What an early-exit error quotes of the runner's own log: enough for the boot-failure anchors
// (signing, tunneld, device busy), bounded so a wedged xcodebuild cannot ship a megabyte in details.
const RUNNER_EARLY_EXIT_LOG_TAIL_BYTES = 64 * 1024;

export function resolveRunnerEarlyExitHint(
  message: string,
  stdout: string,
  stderr: string,
  reason?: BootFailureReason,
): string {
  const haystack = `${message}\n${stdout}\n${stderr}`.toLowerCase();
  if (haystack.includes('device is busy') && haystack.includes('connecting')) {
    return 'Target iOS device is still connecting. Keep it unlocked, wait for device trust/connection to settle, then retry.';
  }
  const classified = reason ?? 'IOS_RUNNER_CONNECT_TIMEOUT';
  // Clearing cached build products cannot put a device into a provisioning
  // profile, so that recovery advice is withheld where it would only add noise
  // to an already actionable instruction.
  if (classified === 'IOS_RUNNER_DEVICE_NOT_PROVISIONED') return bootFailureHint(classified);
  return `${bootFailureHint(classified)} ${RUNNER_CACHE_RECOVERY_HINT}`;
}

function buildRunnerConnectError(params: {
  port: number;
  endpoints: string[];
  logPath?: string;
  lastError: unknown;
  deviceStates?: IosRunnerDeviceStates;
}): AppError {
  const { port, endpoints, logPath, lastError, deviceStates } = params;
  const message = 'Runner did not accept connection';
  const error = new AppError('COMMAND_FAILED', message, {
    port,
    endpoints,
    logPath,
    lastError: lastError ? String(lastError) : undefined,
    reason: classifyBootFailure({
      error: lastError,
      message,
      context: { platform: 'ios', phase: 'connect' },
    }),
    hint: bootFailureHint('IOS_RUNNER_CONNECT_TIMEOUT'),
    ...runnerConnectFailureDetails('runner_connect_refused'),
  });
  // The other way the connect stage gives up: `xcodebuild` is still alive at the deadline. It gets
  // the same enrichment as the early exit below (#2683).
  return enrichRunnerStartupFailureWithDeviceStates(error, deviceStates) as AppError;
}

export async function buildRunnerEarlyExitError(params: {
  session: RunnerSession;
  port: number;
  logPath?: string;
}): Promise<AppError> {
  const { session, port, logPath } = params;
  const result = await session.testPromise;
  const message = 'Runner did not accept connection (xcodebuild exited early)';
  // The runner writes its own output file, so the exec result holds nothing for a file-backed
  // child; that file is what an early exit can quote (#2681).
  const output = session.readLogTail?.(RUNNER_EARLY_EXIT_LOG_TAIL_BYTES) ?? '';
  const reason = classifyBootFailure({
    message,
    stdout: output,
    stderr: output,
    context: { platform: 'ios', phase: 'connect' },
  });
  const simulatorSet = runnerSimulatorSetFailureDetails(session.device);
  const setDestination = classifyRunnerStartupFailure(
    new AppError('COMMAND_FAILED', message, { stderr: output, ...simulatorSet }),
  );
  const setDestinationMissing = setDestination.reason === 'simulator_set_destination_not_found';
  // exec-guard-allow: xcodebuild can exit 0 and still count as an early exit;
  // the trio is nested tool context under `xcodebuild`, classified into
  // `reason`/`hint` above — not a process-exit wrap.
  const error = new AppError(
    'COMMAND_FAILED',
    setDestinationMissing
      ? simulatorSetDestinationNotFoundMessage(message, session.device, simulatorSet)
      : message,
    {
      port,
      // The quote always comes from the runner's own file, so that is the file the error has to name;
      // pointing at the request's log would advertise a file that does not contain what is quoted (#2681).
      logPath: session.runnerLogPath ?? logPath,
      xcodebuild: {
        exitCode: result.exitCode,
        // One merged file since #2681: the tail is reported under `stderr`, which is where readers
        // already look, next to the file it came from.
        stderr: output,
      },
      reason: setDestinationMissing ? setDestination.reason : reason,
      hint: setDestinationMissing
        ? setDestination.hint
        : resolveRunnerEarlyExitHint(message, output, output, reason),
      ...simulatorSet,
      ...runnerConnectFailureDetails('xcodebuild_exited_early'),
    },
  );
  // The build catch is not the only way a runner stops before serving a command. A locked phone lets
  // the build finish and kills `xcodebuild test-without-building` instead, so nothing reaches that
  // catch and the disk-image state read before the build would be dropped. Same enrichment, applied
  // to the failure this path actually produces (#2683).
  return enrichRunnerStartupFailureWithDeviceStates(error, session.startupDeviceStates) as AppError;
}
