import {
  createRequestCanceledError,
  discloseDispatch,
  discloseUnclassifiedDispatch,
  isRequestCanceledError,
  AppError,
} from '@agent-device/kernel/errors';
import { Deadline, retryWithPolicy, classifyBootFailure, bootFailureHint } from './host.ts';
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
  isRunnerCommandProvablyUnwritten,
  isUsbmuxDeviceUnattachedError,
  RUNNER_CACHE_RECOVERY_HINT,
  runnerConnectFailureDetails,
  shouldRetryRunnerConnectError,
  type RunnerStartupFailureReason,
} from './runner-error-classification.ts';
import {
  type RunnerCommand,
  requireTokenEnforcingRunner,
  type RunnerEndpoint,
} from './runner-contract.ts';
import type { RunnerSession } from './runner-session-types.ts';

export type RunnerConnectionSession = Pick<
  RunnerSession,
  | 'startupRetryWake'
  | 'child'
  | 'startupDeviceStates'
  | 'testPromise'
  | 'readLogTail'
  | 'device'
  | 'runnerLogPath'
  | 'state'
>;
import {
  runnerLaunchLogClassificationDetails,
  runnerSimulatorSetFailureDetails,
} from './runner-device-set.ts';
import { canFallBackFromUsbmux, postRunnerCommandOverRoute } from './runner-transport.ts';

export const RUNNER_STARTUP_TIMEOUT_MS = 45_000;
const RUNNER_CONNECT_ATTEMPT_INTERVAL_MS = 250;
const RUNNER_CONNECT_RETRY_BASE_DELAY_MS = 300;
const RUNNER_CONNECT_RETRY_MAX_DELAY_MS = 2_000;
const RUNNER_CONNECT_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Retries one command until the runner answers. The reply is proven to come from a runner that
 * enforces its token; a runner that does not is refused, never retried.
 */
export async function waitForRunner(
  device: DeviceInfo,
  endpoint: RunnerEndpoint,
  command: RunnerCommand,
  logPath?: string,
  timeoutMs: number = RUNNER_STARTUP_TIMEOUT_MS,
  session?: RunnerConnectionSession,
  signal?: AbortSignal,
): Promise<Response> {
  const deadline = Deadline.fromTimeoutMs(timeoutMs);
  const port = endpoint.port;
  const { resolveRoute, markUsbmuxUnattached } = createRunnerCommandRouteResolver(device, port);
  let route = await resolveRoute(deadline.remainingMs());
  let lastError: unknown = null;
  // Every attempt posts the command itself, so the loop gives up "before send" only when no
  // attempt could have written it.
  let commandMayHaveBeenWritten = false;
  const recordAttemptWriteEvidence = (error: unknown): void => {
    if (!isRunnerCommandProvablyUnwritten(error)) commandMayHaveBeenWritten = true;
  };
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / RUNNER_CONNECT_ATTEMPT_INTERVAL_MS));
  let answered: Response | undefined;
  try {
    answered = await retryWithPolicy(
      async ({ deadline: attemptDeadline }) => {
        const response = await attemptRunnerConnection({
          device,
          endpoint,
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
            recordAttemptWriteEvidence(err);
          },
        }).catch((error: unknown) => {
          if (isRequestCanceledError(error)) recordAttemptWriteEvidence(error);
          throw error;
        });
        if (response) return response;
        throw buildRunnerEndpointProbeError({
          port,
          url: route.url,
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
      throw canceledRunnerConnect(commandMayHaveBeenWritten);
    }
    if (isUsbmuxDeviceUnattachedError(error)) throw error;
    if (!lastError) {
      lastError = error;
    }
  }
  if (answered) return requireTokenEnforcingRunner(answered);

  if (signal?.aborted) {
    throw canceledRunnerConnect(commandMayHaveBeenWritten);
  }

  if (session?.child.exitCode !== null && session?.child.exitCode !== undefined) {
    throw withRunnerWriteEvidence(
      await buildRunnerEarlyExitError({ session, port, logPath }),
      commandMayHaveBeenWritten,
    );
  }
  throw withRunnerWriteEvidence(
    buildRunnerConnectError({
      device,
      port,
      url: route.url,
      logPath,
      lastError,
      session,
    }),
    commandMayHaveBeenWritten,
  );
}

function canceledRunnerConnect(commandMayHaveBeenWritten: boolean): AppError {
  return createRequestCanceledError({ dispatched: commandMayHaveBeenWritten ? 'unknown' : 'no' });
}

/**
 * The cancellation one route reports. It keeps `dispatched: no` only when the failure it replaces
 * proves nothing was written (a refused connect, or a cancel seen before the POST); an abort that
 * interrupted the POST itself proves nothing, so the loop reads it as possibly written.
 */
function canceledRunnerAttempt(error: unknown, signal: AbortSignal | undefined): AppError {
  return createRequestCanceledError(
    isProvablyUnwrittenBeforeCancel(error, signal) ? { dispatched: 'no' } : {},
  );
}

/** The request's shared abort reason is never evidence about one send. */
function isProvablyUnwrittenBeforeCancel(error: unknown, signal: AbortSignal | undefined): boolean {
  return error !== signal?.reason && isRunnerCommandProvablyUnwritten(error);
}

/**
 * An earlier attempt that may have written the command may also have executed it, so the loop's
 * failure is `unknown` whatever a later refused attempt stamped.
 */
function withRunnerWriteEvidence(error: unknown, commandMayHaveBeenWritten: boolean): unknown {
  if (!(error instanceof AppError)) return error;
  return commandMayHaveBeenWritten
    ? discloseDispatch(error, 'unknown')
    : discloseUnclassifiedDispatch(error, 'no');
}

type RunnerRouteResolver = ReturnType<typeof createRunnerCommandRouteResolver>['resolveRoute'];

async function attemptRunnerConnection(params: {
  device: DeviceInfo;
  endpoint: RunnerEndpoint;
  command: RunnerCommand;
  timeoutMs: number;
  logPath?: string;
  session?: RunnerConnectionSession;
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

  return await tryRefreshedDeviceTunnel(params, primary.usedCachedTunnelIp);
}

async function ensureRunnerAttemptCanStart(params: {
  endpoint: RunnerEndpoint;
  route: RunnerCommandRoute;
  timeoutMs: number;
  logPath?: string;
  session?: RunnerConnectionSession;
  attemptDeadline?: Deadline;
}): Promise<void> {
  if (params.attemptDeadline?.isExpired()) {
    throw new AppError('COMMAND_FAILED', 'Runner connection deadline exceeded', {
      port: params.endpoint.port,
      timeoutMs: params.timeoutMs,
    });
  }
  if (params.session?.child.exitCode !== null && params.session?.child.exitCode !== undefined) {
    throw await buildRunnerEarlyExitError({
      session: params.session,
      port: params.endpoint.port,
      logPath: params.logPath,
    });
  }
  // A launch whose log already names a cause the classifier calls terminal will never serve a
  // command, and its child may stay alive to the deadline, so without this the request waits out the
  // whole connect budget before reaching the failure that names the cause (#3449). The verdict is the
  // classifier's over the tail — this adds no matching of its own — and it is acted on only when the
  // table says a retry cannot help, which is the same predicate the retry loop applies to errors.
  // Checked while the session has yet to answer: once a runner has answered, its log is no longer
  // evidence about a boot that demonstrably succeeded. Bounded to the tail an error would quote, read
  // from this generation's offset, and no child process is spawned for it.
  const session = params.session;
  if (session?.state !== 'starting') return;
  const launchLogOutput = session.readLogTail?.(RUNNER_EARLY_EXIT_LOG_TAIL_BYTES) ?? '';
  if (!launchLogOutput) return;
  const terminalError = buildRunnerConnectError({
    device: session.device,
    port: params.endpoint.port,
    url: params.route.url,
    logPath: params.logPath,
    lastError: null,
    session,
    launchLogOutput,
  });
  if (!shouldRetryRunnerConnectError(terminalError)) throw terminalError;
}

async function tryPrimaryRunnerRoute(params: {
  device: DeviceInfo;
  endpoint: RunnerEndpoint;
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
    return await tryRunnerRoute(params.device, current, {
      command: params.command,
      endpoint: params.endpoint,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
      attemptDeadline: params.attemptDeadline,
      onUsbmuxUnattached: params.markUsbmuxUnattached,
      onError: (err) => {
        params.setLastError(err);
        // A usbmux-first attempt only learns its cached tunnel address after falling back, and a
        // stale one must still be invalidated.
        if (params.device.kind === 'device' && current.cachedTunnelIp) {
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

async function tryRefreshedDeviceTunnel(
  params: {
    device: DeviceInfo;
    endpoint: RunnerEndpoint;
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
    endpoint: params.endpoint,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
    attemptDeadline: params.attemptDeadline,
    onError: params.setLastError,
  });
}

function buildRunnerEndpointProbeError(params: {
  port: number;
  url: string | null;
  lastError: unknown;
  signal?: AbortSignal;
}): AppError {
  if (params.signal?.aborted) {
    throw createRequestCanceledError();
  }
  return new AppError('COMMAND_FAILED', 'Runner endpoint probe failed', {
    port: params.port,
    url: params.url,
    lastError: params.lastError ? String(params.lastError) : undefined,
    ...runnerConnectFailureDetails('runner_endpoint_probe_exhausted'),
  });
}

async function tryRunnerRoute(
  device: DeviceInfo,
  route: RunnerCommandRoute,
  params: {
    command: RunnerCommand;
    endpoint: RunnerEndpoint;
    timeoutMs: number;
    signal?: AbortSignal;
    attemptDeadline?: Deadline;
    onUsbmuxUnattached?: () => void;
    onError: (error: unknown) => void;
  },
): Promise<Response | null> {
  const remainingMs = params.attemptDeadline?.remainingMs() ?? params.timeoutMs;
  try {
    return await postRunnerCommandOverRoute(device, route, {
      endpoint: params.endpoint,
      command: params.command,
      timeoutMs: Math.min(RUNNER_CONNECT_REQUEST_TIMEOUT_MS, remainingMs),
      signal: params.signal,
    });
  } catch (error) {
    if (params.signal?.aborted || isRequestCanceledError(error)) {
      throw canceledRunnerAttempt(error, params.signal);
    }
    if (route.kind === 'usbmux' && isUsbmuxDeviceUnattachedError(error)) {
      if (!canFallBackFromUsbmux(device, error)) {
        // No tunnel exists for this device, so retrying cannot attach a cable.
        // Throw the typed verdict so its recovery hint survives instead of
        // being replaced by a generic connect failure.
        throw error;
      }
      params.onUsbmuxUnattached?.();
      return null;
    }
    params.onError(error);
    return null;
  }
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

/** The cause a runner launch log names, in the shape both connect-stage failures publish. */
type RunnerLaunchLogCause = Readonly<{
  message: string;
  reason: RunnerStartupFailureReason;
  hint: string;
}>;

/**
 * The cause readable from the launch output when the runner never served a command, if any. Which
 * outputs carry a cause, what it is called, and what the sentence beside it says are all decided by the
 * classifier's rows: this reads the tail's verdict and folds the row's own words into the message, so
 * reason, message and hint cannot disagree about which cause this was (#3449). No cause is claimed for
 * anything no row named: the boot-failure classification owns those.
 */
function resolveRunnerLaunchLogCause(params: {
  message: string;
  output: string;
  device: DeviceInfo;
}): RunnerLaunchLogCause | undefined {
  const classified = classifyRunnerStartupFailure(
    new AppError('COMMAND_FAILED', params.message, {
      stderr: params.output,
      ...runnerLaunchLogClassificationDetails(params.device),
    }),
  );
  if (!classified.messageSuffix) return undefined;
  return {
    message: `${params.message}: ${classified.messageSuffix}`,
    reason: classified.reason,
    hint: classified.hint,
  };
}

function buildRunnerConnectError(params: {
  device: DeviceInfo;
  port: number;
  url: string | null;
  logPath?: string;
  lastError: unknown;
  session?: RunnerConnectionSession;
  /** The launch tail already read for this decision; read here when it is absent. */
  launchLogOutput?: string;
}): AppError {
  const { device, port, url, logPath, lastError, session } = params;
  const message = 'Runner did not accept connection';
  const launchLogCause = resolveRunnerLaunchLogCause({
    message,
    output:
      params.launchLogOutput ?? session?.readLogTail?.(RUNNER_EARLY_EXIT_LOG_TAIL_BYTES) ?? '',
    device,
  });
  const error = new AppError('COMMAND_FAILED', launchLogCause?.message ?? message, {
    port,
    url,
    // A cause read from the launch log has to name the file the reader can check it against; the
    // request's own log is not necessarily that file (#2681).
    logPath: launchLogCause ? (session?.runnerLogPath ?? logPath) : logPath,
    lastError: lastError ? String(lastError) : undefined,
    reason:
      launchLogCause?.reason ??
      classifyBootFailure({
        error: lastError,
        message,
        context: { platform: 'ios', phase: 'connect' },
      }),
    hint: launchLogCause?.hint ?? bootFailureHint('IOS_RUNNER_CONNECT_TIMEOUT'),
    ...runnerConnectFailureDetails('runner_connect_refused'),
  });
  // The other way the connect stage gives up: `xcodebuild` is still alive at the deadline. It gets
  // the same enrichment as the early exit below (#2683).
  return enrichRunnerStartupFailureWithDeviceStates(
    error,
    session?.startupDeviceStates,
  ) as AppError;
}

export async function buildRunnerEarlyExitError(params: {
  session: RunnerConnectionSession;
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
  const launchLogCause = resolveRunnerLaunchLogCause({ message, output, device: session.device });
  // exec-guard-allow: xcodebuild can exit 0 and still count as an early exit;
  // the trio is nested tool context under `xcodebuild`, classified into
  // `reason`/`hint` above — not a process-exit wrap.
  const error = new AppError('COMMAND_FAILED', launchLogCause?.message ?? message, {
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
    reason: launchLogCause?.reason ?? reason,
    hint: launchLogCause?.hint ?? resolveRunnerEarlyExitHint(message, output, output, reason),
    ...simulatorSet,
    ...runnerConnectFailureDetails('xcodebuild_exited_early'),
  });
  // The build catch is not the only way a runner stops before serving a command. A locked phone lets
  // the build finish and kills `xcodebuild test-without-building` instead, so nothing reaches that
  // catch and the disk-image state read before the build would be dropped. Same enrichment, applied
  // to the failure this path actually produces (#2683).
  return enrichRunnerStartupFailureWithDeviceStates(error, session.startupDeviceStates) as AppError;
}
