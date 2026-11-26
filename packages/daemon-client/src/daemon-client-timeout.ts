import { AppError } from '@agent-device/kernel/errors';
import { DAEMON_TRANSPORT_REASONS } from './daemon-client-transport-reasons.ts';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { DaemonRetirementResult } from '@agent-device/daemon-contracts/daemon-registration-owner';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { resolveCommandTimeoutPolicy } from '@agent-device/command-registry/registry';
import type { DaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import type { PlatformSelector } from '@agent-device/kernel/device';
import { observedDaemonIdentityOf, type DaemonInfo } from './daemon-client-metadata.ts';
import type { DaemonProbeVerdict } from './daemon-client-loopback-probe.ts';
import type { RemoteDaemonHealth } from './daemon-client-transport.ts';

// Recovery for a timed-out request is scoped to that request or to nothing. The daemon owns
// request-scoped recovery (#3177): destroying the timed-out connection cancels exactly that
// request, and the cancel retires the runner work the request owned. The client used to recover
// host-scoped on both ends — a `pkill -f` sweep matching every agent-device runner xcodebuild,
// which sabotaged that cancel path (a swept kill reads as a host failure, not a canceled request)
// and duplicated cleanup the daemon scopes to its own leases — plus a daemon SIGKILL that ended
// every sibling session. The SIGKILL survives only behind the liveness probe below: the question
// the reset used to assume. That probe and the registration fence load on demand: a timed-out
// request is their only caller, and the CLI's eager closure (the ADR 0019 loading-shape probe)
// must not pay for a recovery path a healthy invocation never runs.

export async function handleRequestTimeout(
  params: Readonly<{
    info: DaemonInfo;
    statePaths: DaemonPaths;
    remote: boolean;
    /**
     * Whether this caller may retire a daemon that answers nothing. An attach client never may: the
     * daemon is not its to kill. `ensureDaemon` reuses a compatible daemon that accepts a
     * connection without asking it anything, so that one is ended only by a deliberate stop.
     */
    retireUnresponsive: boolean;
    timeoutMs: number;
    requestId: string | undefined;
    command: string | undefined;
    platform: PlatformSelector | undefined;
    /** Named together so the recovery hint cannot be assembled from a swapped session and action. */
    session?: string;
    action?: string;
    /** Whether the request left this process before the window expired. */
    requestSent: boolean;
    /** Whether the remote daemon had already opened a 2xx progress stream before the timeout. */
    responseStarted: boolean;
    /** Reads the remote daemon's `/health` within a budget. The transport owns the request. */
    readRemoteHealth: (budgetMs: number) => Promise<RemoteDaemonHealth>;
  }>,
): Promise<AppError> {
  const {
    info,
    statePaths,
    remote,
    retireUnresponsive,
    timeoutMs,
    requestId,
    command,
    session,
    requestSent,
    responseStarted,
    readRemoteHealth,
  } = params;
  // The command's declared policy (`timeoutPolicy.onTimeout`, ADR 0008) decides whether a local
  // timed-out request is RESET-ELIGIBLE; the liveness probe decides whether the eligibility runs.
  // A remote client cannot reach the host's process table or the daemon's state dir, so a remote
  // timeout stays purely declarative here.
  const resetEligible = !remote && shouldResetDaemonAfterRequestTimeout(command);
  const liveness = resetEligible ? await probeDaemonLiveness(info, session) : undefined;
  const remoteProof = await resolveRemoteTimeoutProof({
    remote,
    requestSent,
    responseStarted,
    readRemoteHealth,
  });
  const recovery = await recoverFromTimeout({ info, statePaths, liveness, retireUnresponsive });
  emitTimeoutDiagnostic({
    timeoutMs,
    requestId,
    command,
    remote,
    info,
    liveness,
    remoteProof,
    recovery,
  });
  return await timeoutFailure({ params, statePaths, liveness, remoteProof, recovery });
}

// The answer only picks the hint, so a probe that misses costs the old wording, not a recovery, and
// it must not add the full health-check window to every remote timeout.
const REMOTE_TIMEOUT_HEALTH_PROBE_MS = 1_000;

/** What a sent remote request proved about the daemon URL and auth token before or after timeout. */
type RemoteTimeoutProof = Readonly<{
  /** Set for a sent remote request: whether a 2xx progress stream had opened before the timeout. */
  responseStarted?: boolean;
  /** Set when no progress stream had opened and `/health` was checked instead. */
  healthAnswered?: boolean;
}>;

/**
 * Whether a sent remote request already proved that the URL and auth token were fine.
 * A 2xx progress stream proves both without another round trip. Non-streaming callers (`--json`,
 * MCP, SDK) and streams that emitted no progress before the timeout ask `/health` once (1 s cap)
 * and require a 2xx with a contract daemon or proxy `service`; `/health` checks no token, but
 * `/rpc` refuses a wrong one at once, so a timed-out request had already passed it.
 */
async function resolveRemoteTimeoutProof(
  params: Readonly<{
    remote: boolean;
    requestSent: boolean;
    responseStarted: boolean;
    readRemoteHealth: (budgetMs: number) => Promise<RemoteDaemonHealth>;
  }>,
): Promise<RemoteTimeoutProof> {
  if (!params.remote || !params.requestSent) return {};
  if (params.responseStarted) return { responseStarted: true };
  const health = await params.readRemoteHealth(REMOTE_TIMEOUT_HEALTH_PROBE_MS);
  return {
    responseStarted: false,
    healthAnswered:
      health.reachable &&
      health.statusCode !== undefined &&
      health.statusCode < 300 &&
      health.service !== undefined,
  };
}

/**
 * Asks the registered daemon whether it is alive, over the endpoints a reset would have retired it
 * from. Loaded here and not at the module's top: a timeout is the only path that asks, and the CLI's
 * eager closure must not pay for the probe.
 */
async function probeDaemonLiveness(
  info: DaemonInfo,
  session: string | undefined,
): Promise<DaemonProbeVerdict> {
  const { answersLivenessProbe } = await import('./daemon-client-liveness-probe.ts');
  return await answersLivenessProbe(info, { session });
}

/** What one timeout's liveness verdict authorized this caller to do about the daemon. */
type TimeoutRecovery = Readonly<{
  /** Set when the daemon is unresponsive AND this caller may retire it. */
  mayRetire: boolean;
  /** Set when the daemon answered nothing and this caller must be told to stop it by hand instead. */
  stopCommand: string | undefined;
  /** The teardown this caller performed, when it performed one. */
  retirement: DaemonRetirementResult | undefined;
}>;

/**
 * A daemon that answers the probe is busy or slow, not gone: the request-scoped cancel its transport
 * performed when this client's connection died is the recovery that request needed, and sibling
 * sessions survive. Only a daemon answering neither endpoint in the probe window is the hung daemon a
 * reset was designed for, and only a caller that owns the daemon's lifecycle may perform it.
 *
 * A probe the HOST refused is neither an answer nor an unresponsive verdict: this client holds no
 * evidence about the daemon, so a reset-eligible timeout does not retire it.
 */
async function recoverFromTimeout(
  params: Readonly<{
    info: DaemonInfo;
    statePaths: DaemonPaths;
    /** Absent when the command's policy declares no reset, or the client is remote. */
    liveness: DaemonProbeVerdict | undefined;
    retireUnresponsive: boolean;
  }>,
): Promise<TimeoutRecovery> {
  const { info, statePaths, liveness, retireUnresponsive } = params;
  const unresponsive = liveness !== undefined && !liveness.reachable && !liveness.denial;
  const mayRetire = unresponsive && retireUnresponsive;
  // Loaded only on the branch that names it: the same eager-closure rule as the probe above.
  const stopCommand =
    unresponsive && !retireUnresponsive
      ? (await import('./daemon-lifecycle-errors.ts')).daemonStopCommand(statePaths.baseDir)
      : undefined;
  const retirement = mayRetire ? await forceRetireDaemon(info, statePaths) : undefined;
  return { mayRetire, stopCommand, retirement };
}

/** One diagnostic for one timed-out request: what was asked, what was found, what was done. */
function emitTimeoutDiagnostic(
  params: Readonly<{
    timeoutMs: number;
    requestId: string | undefined;
    command: string | undefined;
    remote: boolean;
    info: DaemonInfo;
    liveness: DaemonProbeVerdict | undefined;
    remoteProof: RemoteTimeoutProof;
    recovery: TimeoutRecovery;
  }>,
): void {
  const { timeoutMs, requestId, command, remote, info, liveness, remoteProof, recovery } = params;
  const { retirement } = recovery;
  const resetDaemon = retirement?.status === 'retired';
  const preserved =
    retirement?.status === 'retained' && retirement.termination?.status !== 'exited';
  emitDiagnostic({
    level: 'error',
    phase: 'daemon_request_timeout',
    data: {
      timeoutMs,
      requestId,
      command,
      daemonPidReset: resetDaemon ? info.pid : undefined,
      daemonPidForceKilled: resetDaemon ? daemonWasForceKilled(retirement) : undefined,
      daemonRetirement: retirement,
      daemonPreservedAfterTimeout: preserved || (!remote && !recovery.mayRetire),
      daemonLivenessProbeAnswered: liveness?.reachable,
      daemonLivenessConnectDenied: liveness?.denial,
      remoteResponseStarted: remoteProof.responseStarted,
      remoteHealthAnswered: remoteProof.healthAnswered,
      daemonBaseUrl: info.baseUrl,
    },
  });
}

/**
 * The failure a timed-out request answers with.
 *
 * A probe the HOST refused answers `daemon-connect-denied` and not a timeout: this client learned
 * nothing about the daemon, so the timeout's own hints would describe a session the caller cannot
 * reach rather than the sandbox that refused the connect. The daemon is left running either way.
 */
async function timeoutFailure(
  params: Readonly<{
    params: Parameters<typeof handleRequestTimeout>[0];
    statePaths: DaemonPaths;
    liveness: DaemonProbeVerdict | undefined;
    remoteProof: RemoteTimeoutProof;
    recovery: TimeoutRecovery;
  }>,
): Promise<AppError> {
  const { params: request, statePaths, liveness, remoteProof, recovery } = params;
  const { timeoutMs, requestId, requestSent } = request;
  const { retirement } = recovery;
  if (liveness?.denial) {
    const { daemonConnectDeniedError } = await import('./daemon-lifecycle-errors.ts');
    const denied = daemonConnectDeniedError({
      info: request.info,
      denial: liveness.denial,
      stateDir: statePaths.baseDir,
    });
    // A refusal found AFTER the request left this process replaces the timeout's REASON, not the
    // timeout's facts: the daemon may still have run this request, and a caller that retries on a
    // failure that dispatched nothing would run it twice. `daemonRequestSent` travels with the denial
    // so the send path can disclose dispatch for it, exactly as it does for a timeout.
    if (requestSent) denied.details = { ...denied.details, daemonRequestSent: true };
    return denied;
  }
  return new AppError('COMMAND_FAILED', 'Daemon request timed out', {
    timeoutMs,
    requestId,
    reason: DAEMON_TRANSPORT_REASONS.timeout.reason,
    daemonRequestSent: requestSent,
    ...(remoteProof.responseStarted !== undefined
      ? { remoteResponseStarted: remoteProof.responseStarted }
      : {}),
    ...(remoteProof.healthAnswered !== undefined
      ? { remoteHealthAnswered: remoteProof.healthAnswered }
      : {}),
    ...(retirement ? { retirement, stateDir: statePaths.baseDir } : {}),
    hint: resolveTimeoutHint({ request, remoteProof, recovery, stateDir: statePaths.baseDir }),
  });
}

/**
 * Either the notice that a teardown kept the daemon's state on disk, or the recovery hint for this
 * request. Split from the error above so the hint's own branches stay readable.
 */
function resolveTimeoutHint(
  params: Readonly<{
    request: Parameters<typeof handleRequestTimeout>[0];
    remoteProof: RemoteTimeoutProof;
    recovery: TimeoutRecovery;
    stateDir: string;
  }>,
): string {
  const { request, remoteProof, recovery, stateDir } = params;
  const { retirement } = recovery;
  if (retirement?.status === 'retained') {
    return `The daemon could not be safely retired. State was retained at ${stateDir}. ${retirement.error?.hint ?? 'Read the request log and daemon.log in that directory before you retry.'}`;
  }
  return resolveRequestTimeoutHint({
    remote: request.remote,
    remoteResponseStarted: remoteProof.responseStarted,
    remoteHealthAnswered: remoteProof.healthAnswered,
    resetDaemon: retirement?.status === 'retired',
    stopCommand: recovery.stopCommand,
    command: request.command,
    applePlatformDeclared: isAffirmativelyApplePlatform(request.platform),
    session: request.session,
    action: request.action,
  });
}

async function forceRetireDaemon(
  info: DaemonInfo,
  statePaths: DaemonPaths,
): Promise<DaemonRetirementResult> {
  const { stopAndRetireDaemon } =
    await import('@agent-device/daemon-contracts/daemon-registration-owner');
  return await stopAndRetireDaemon({
    paths: statePaths,
    observed: observedDaemonIdentityOf(info),
    mode: 'force',
  });
}

// Whether a timed-out request is eligible to tear down the local daemon is declared on the
// command's descriptor (ADR 0008, `timeoutPolicy.onTimeout`): read-only capture/polling commands
// preserve the daemon so sessions survive and evidence commands still work; everything else is
// eligible. Execution of the eligibility is gated by the liveness probe — the descriptor says a
// reset is allowed where the daemon is unreachable, never that a slow-but-alive daemon may lose
// every session it owns. Unknown/undefined commands fall back to the default reset-eligible
// policy, which matches the old hand lists: not listed meant default envelope + reset.
function shouldResetDaemonAfterRequestTimeout(command: string | undefined): boolean {
  return resolveCommandTimeoutPolicy(command).onTimeout === 'reset-daemon';
}

// `--platform` selectors that AFFIRMATIVELY name (or alias) an Apple device. This is the
// hint-wording gate: the hint names Apple-runner involvement only where this call site has
// evidence for it — an explicitly declared Apple platform selector. The sweep that used to offer
// "terminated something" as evidence is gone (#3177), and an undeclared or declared non-Apple
// platform is not evidence of anything.
const AFFIRMATIVE_APPLE_PLATFORM_SELECTORS: ReadonlySet<PlatformSelector> = new Set([
  'apple',
  'ios',
  'macos',
]);

function isAffirmativelyApplePlatform(platform: PlatformSelector | undefined): boolean {
  return platform !== undefined && AFFIRMATIVE_APPLE_PLATFORM_SELECTORS.has(platform);
}

/** The step that runs Apple runner startup under `prepare`'s own envelope. */
const PREPARE_RUNNER_STEP = 'run agent-device prepare ios-runner with the same --platform';

// Exported for direct hint-matrix testing: handleRequestTimeout also runs the real liveness probe
// and process-kill side effects, so its wording is verified through this pure sub-function
// (see also the production-seam route tests in
// packages/daemon-client/src/__tests__/daemon-client-timeout-route.test.ts, which prove the
// liveness-gated recovery this route performs — the side of the contract a pure formatter test
// cannot reach).
export function resolveRequestTimeoutHint(params: {
  remote: boolean;
  /** Whether a remote daemon had already opened a 2xx progress stream before the timeout. */
  remoteResponseStarted?: boolean;
  /** Whether a remote daemon answered `/health` after the timeout. */
  remoteHealthAnswered?: boolean;
  resetDaemon: boolean;
  /** Set when the daemon answered nothing and this caller is not allowed to retire it. */
  stopCommand?: string;
  command: string | undefined;
  /** Only ever consulted on the kept-alive branch, where an Apple hint has evidence to stand on. */
  applePlatformDeclared: boolean;
  /** The request's first positional, for commands whose recovery depends on which action ran. */
  action?: string;
  session?: string;
}): string {
  const {
    remote,
    remoteResponseStarted,
    remoteHealthAnswered,
    resetDaemon,
    stopCommand,
    command,
    applePlatformDeclared,
    session,
    action,
  } = params;
  // A daemon that survives this client window may still be exporting a `record stop` that ran out
  // of time — a stop still queued for the device lock is dropped before any export starts, hence
  // "may" — and a finished file stays retrievable by asking again. This holds whether the daemon
  // survived because the request was remote or because `record` declares preserve-daemon (#3199).
  // A reset daemon makes no such promise.
  if (!resetDaemon && command === PUBLIC_COMMANDS.record && action === 'stop') {
    return `The ${remote ? 'remote ' : ''}daemon may still be exporting the recording. Run agent-device record stop${
      session ? ` --session ${session}` : ''
    } again to wait for that export and receive the completed recording.`;
  }
  if (remote) {
    return resolveRemoteTimeoutHint({
      command,
      applePlatformDeclared,
      remoteResponseStarted,
      remoteHealthAnswered,
    });
  }
  if (resetDaemon) {
    // The reset SIGKILLs the daemon pid only; child processes it owned (Apple runners included)
    // are not proven stopped from here, so the hint claims nothing about them.
    return 'The daemon did not answer the liveness probes and was reset after the timeout. Read the request log for the timed-out step.';
  }
  if (stopCommand) {
    return `The daemon did not answer the liveness probes, and this request does not retire a daemon it did not start. Stop it with ${stopCommand}. Then retry; an SDK client calls ensureDaemon() after the stop, because it reuses a daemon that still accepts connections.`;
  }
  const iosPrepareHint =
    applePlatformDeclared && command === PUBLIC_COMMANDS.snapshot
      ? ` If this was the first Apple-platform snapshot on the device, ${PREPARE_RUNNER_STEP} before snapshot/test so runner startup is handled explicitly.`
      : '';
  // The daemon canceled the request when this client's connection was destroyed, and stayed
  // reachable (the probe answered, or the command's policy forbids the reset), so the session
  // survives and can still be closed or inspected.
  return `The timed-out ${
    command ?? 'request'
  } request was canceled; the daemon was kept alive so the session can still be closed or inspected. Read the request log for the timed-out step.${iosPrepareHint}`;
}

function resolveRemoteTimeoutHint(
  params: Readonly<{
    command: string | undefined;
    applePlatformDeclared: boolean;
    remoteResponseStarted?: boolean;
    remoteHealthAnswered?: boolean;
  }>,
): string {
  const { command, applePlatformDeclared, remoteResponseStarted, remoteHealthAnswered } = params;
  if (remoteResponseStarted) {
    return resolveReachableRemoteTimeoutHint(command, applePlatformDeclared, 'response-started');
  }
  if (remoteHealthAnswered) {
    return resolveReachableRemoteTimeoutHint(command, applePlatformDeclared, 'health');
  }
  return 'Verify the remote daemon URL, auth token, and remote host logs.';
}

// The daemon cancels a request whose connection closed (directly and through agent-device-proxy,
// #5058), so a timed-out `open` leaves nothing that a retry could race. The CLI prints the
// observe-first step before this hint, since the open may have launched the app, so the retry is
// stated as safe whatever that check shows. A first Apple open can spend the default envelope
// building and starting the XCTest runner (#5004); `prepare` runs that startup under its own
// longer envelope.
function resolveReachableRemoteTimeoutHint(
  command: string | undefined,
  applePlatformDeclared: boolean,
  proof: 'response-started' | 'health',
): string {
  const reachable =
    proof === 'response-started'
      ? 'The remote daemon already started answering this request, so its URL and auth token are not the cause.'
      : 'The remote daemon still answers /health, so its URL and auth token are not the cause.';
  if (command !== PUBLIC_COMMANDS.open) {
    return `${reachable} Read the remote host logs for the timed-out ${command ?? 'request'} step.`;
  }
  const retry =
    'The daemon canceled this open, so running it again is safe even if the app launched.';
  if (!applePlatformDeclared) return `${reachable} ${retry}`;
  return `${reachable} A first Apple open can outlast the request window while the host builds and starts the XCTest runner. ${retry} For a longer startup window, ${PREPARE_RUNNER_STEP} first.`;
}

function daemonWasForceKilled(retirement: DaemonRetirementResult | undefined): boolean {
  if (!retirement || retirement.status === 'absent') return false;
  const termination = retirement.termination;
  return termination?.status === 'exited' && termination.mode === 'forced';
}
