import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { DaemonRetirementResult } from '../daemon-registration-owner.ts';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { resolveCommandTimeoutPolicy } from '@agent-device/command-registry/registry';
import type { DaemonPaths } from '../daemon-resolution.ts';
import type { PlatformSelector } from '@agent-device/kernel/device';
import type { DaemonInfo } from './daemon-client-metadata.ts';

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
    timeoutMs: number;
    requestId: string | undefined;
    command: string | undefined;
    platform: PlatformSelector | undefined;
    /** Named together so the recovery hint cannot be assembled from a swapped session and action. */
    session?: string;
    action?: string;
  }>,
): Promise<AppError> {
  const { info, statePaths, remote, timeoutMs, requestId, command, platform, session, action } =
    params;
  // The command's declared policy (`timeoutPolicy.onTimeout`, ADR 0008) decides whether a local
  // timed-out request is RESET-ELIGIBLE; the liveness probe decides whether the eligibility runs.
  // A remote client cannot reach the host's process table or the daemon's state dir, so a remote
  // timeout stays purely declarative here.
  const resetEligible = !remote && shouldResetDaemonAfterRequestTimeout(command);
  // A daemon that answers the probe is busy or slow, not gone: the request-scoped cancel its
  // transport performed when this client's connection died is the recovery that request needed,
  // and sibling sessions survive. Only a daemon answering neither endpoint in the probe window is
  // the hung daemon a reset was designed for.
  const probeAnswered = resetEligible
    ? await (
        await import('./daemon-client-liveness-probe.ts')
      ).probeDaemonResponsive(info, {
        session,
      })
    : undefined;
  const unresponsive = probeAnswered === false;
  let retirement: DaemonRetirementResult | undefined;
  if (unresponsive) {
    const { stopAndRetireDaemon } = await import('../daemon-registration-owner.ts');
    retirement = await stopAndRetireDaemon({
      paths: statePaths,
      observed: { pid: info.pid, startTime: info.processStartTime ?? null },
      mode: 'force',
    });
  }
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
      daemonPreservedAfterTimeout: preserved || (!remote && !unresponsive),
      daemonLivenessProbeAnswered: probeAnswered,
      daemonBaseUrl: info.baseUrl,
    },
  });
  return new AppError('COMMAND_FAILED', 'Daemon request timed out', {
    timeoutMs,
    requestId,
    reason: 'daemon_transport_timeout',
    ...(retirement ? { retirement, stateDir: statePaths.baseDir } : {}),
    hint:
      retirement?.status === 'retained'
        ? `The daemon could not be safely retired. State was retained at ${statePaths.baseDir}. ${retirement.error?.hint ?? 'Retry with --debug and inspect daemon diagnostics before retrying.'}`
        : resolveRequestTimeoutHint({
            remote,
            resetDaemon: resetDaemon,
            command,
            applePlatformDeclared: isAffirmativelyApplePlatform(platform),
            session,
            action,
          }),
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

// Exported for direct hint-matrix testing: handleRequestTimeout also runs the real liveness probe
// and process-kill side effects, so its wording is verified through this pure sub-function
// (see also the production-seam route tests in
// src/daemon-client/__tests__/daemon-client-timeout-route.test.ts, which prove the liveness-gated
// recovery this route performs — the side of the contract a pure formatter test cannot reach).
export function resolveRequestTimeoutHint(params: {
  remote: boolean;
  resetDaemon: boolean;
  command: string | undefined;
  /** Only ever consulted on the kept-alive branch, where an Apple hint has evidence to stand on. */
  applePlatformDeclared: boolean;
  /** The request's first positional, for commands whose recovery depends on which action ran. */
  action?: string;
  session?: string;
}): string {
  const { remote, resetDaemon, command, applePlatformDeclared, session, action } = params;
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
    return 'Retry with --debug and verify the remote daemon URL, auth token, and remote host logs.';
  }
  if (resetDaemon) {
    // The reset SIGKILLs the daemon pid only; child processes it owned (Apple runners included)
    // are not proven stopped from here, so the hint claims nothing about them.
    return 'Retry with --debug and check daemon diagnostics logs. The daemon did not answer the liveness probe and was reset after the timeout.';
  }
  const iosPrepareHint =
    applePlatformDeclared && command === PUBLIC_COMMANDS.snapshot
      ? ' If this was the first Apple-platform snapshot on the device, run agent-device prepare ios-runner with the same --platform before snapshot/test so runner startup is handled explicitly.'
      : '';
  // The daemon canceled the request when this client's connection was destroyed, and stayed
  // reachable (the probe answered, or the command's policy forbids the reset), so the session
  // survives and can still be closed or inspected.
  return `Retry with --debug and check daemon diagnostics logs. The timed-out ${
    command ?? 'request'
  } request was canceled; the daemon was kept alive so the session can still be closed or inspected.${iosPrepareHint}`;
}

function daemonWasForceKilled(retirement: DaemonRetirementResult | undefined): boolean {
  if (!retirement || retirement.status === 'absent') return false;
  const termination = retirement.termination;
  return termination?.status === 'exited' && termination.mode === 'forced';
}
