import type {
  DaemonConnection,
  DaemonIdentity,
  EnsureDaemonOptions,
} from '@agent-device/contracts/client';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { captureHostEnvironment } from '@agent-device/host-kit/process';
import {
  DAEMON_TEARDOWN_GRACE_MS,
  waitForDaemonExit,
} from '@agent-device/daemon-contracts/daemon-process';
import { recoverAbandonedDaemonRegistration } from '@agent-device/daemon-contracts/daemon-registration-owner';
import { sleep } from '@agent-device/host-kit/retry';
import { AppError } from '@agent-device/kernel/errors';
import { DAEMON_TRANSPORT_REASONS } from './daemon-client-transport-reasons.ts';
import { resolveLocalDaemonSettings } from './daemon-client-lifecycle.ts';
import {
  assertDaemonPolicyMatches,
  observeLocalDaemon,
  retireDaemonForTakeover,
  startLocalDaemon,
  stopDaemonForTakeover,
} from './daemon-client-startup.ts';
import type { DaemonClientSettings, EnsuredDaemon } from './daemon-client-lifecycle.ts';
import { DAEMON_LEAVE_WAIT_MS, requestDaemonLifecycle } from './daemon-client-lifecycle-request.ts';
import { answersLivenessProbe } from './daemon-client-liveness-probe.ts';
import { observedDaemonIdentityOf, type DaemonInfo } from './daemon-client-metadata.ts';
import {
  DAEMON_UNAVAILABLE_REASONS,
  daemonConnectDeniedError,
  daemonIdentityOf,
  daemonDrainTimeoutError,
  daemonIncompatibleError,
  daemonRetirementUnconfirmedError,
} from './daemon-lifecycle-errors.ts';

// A racing `ensureDaemon` in another process can retire or replace the daemon this call judged, or
// a daemon this call quiesced can still be leaving. A judgement that went stale is made again after
// a short wait, for as long as a drain can take.
const JUDGE_AGAIN_DELAY_MS = 250;
const DRAIN_POLL_MS = 250;

type EnsureStep =
  | { kind: 'connected'; daemon: EnsuredDaemon; started: boolean }
  | { kind: 'judge-again' };

/**
 * Makes the local daemon on a state directory usable by this client, and says what it did.
 *
 * A missing daemon is started. An incompatible one is replaced only if it agrees to leave: the
 * daemon itself refuses while it holds a request, a session, a repair session or a live lease, so
 * this never destroys another client's work, and a daemon that cannot be asked is never replaced.
 * A daemon that answers nothing is retired after repeated failed liveness probes. A remote
 * connection has no local daemon to ensure, so this takes no remote option and reads no remote
 * environment.
 */
export async function ensureDaemon(
  options: EnsureDaemonOptions = {},
  host: HostEnvironment = captureHostEnvironment(process),
): Promise<DaemonConnection> {
  const settings = resolveLocalDaemonSettings(options, host);
  // The budget is one teardown grace of elapsed time: a state directory another process keeps
  // replacing holds this call for the grace, not for a grace of judgements plus what each judgement
  // cost. `maxWaits` backstops the deadline, which cannot end the loop on a clock that stops. The
  // deadline is monotonic, like the transport and lifecycle budgets: a wall-clock step would shorten
  // the grace, and `sleep` itself counts waiting monotonically.
  const deadlineAtMs = performance.now() + DAEMON_TEARDOWN_GRACE_MS;
  const maxWaits = Math.ceil(DAEMON_TEARDOWN_GRACE_MS / JUDGE_AGAIN_DELAY_MS);
  for (let waits = 0; ; waits += 1) {
    const step = await ensureOnce(settings, options.onStart);
    if (step.kind === 'connected') {
      await assertDaemonPolicyMatches(step.daemon.info, settings.paths.baseDir, host);
      return {
        stateDir: settings.paths.baseDir,
        daemon: daemonIdentityOf(step.daemon.info),
        started: step.started,
      };
    }
    if (waits >= maxWaits) break;
    const remainingMs = deadlineAtMs - performance.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(JUDGE_AGAIN_DELAY_MS, remainingMs));
  }
  throw new AppError('COMMAND_FAILED', 'The daemon kept changing while it was being ensured.', {
    reason: DAEMON_UNAVAILABLE_REASONS.lifecycleContended.reason,
    stateDir: settings.paths.baseDir,
    hint: 'Another process is starting or replacing the daemon on this state directory. Retry.',
  });
}

async function ensureOnce(
  settings: DaemonClientSettings,
  onStart: EnsureDaemonOptions['onStart'],
): Promise<EnsureStep> {
  const observed = await observeLocalDaemon(settings, { refineUnreachable: true });
  if (!observed) return await start(settings, onStart, 'missing');
  const { info, decision } = observed;
  switch (decision.kind) {
    case 'reuse':
      return { kind: 'connected', daemon: { info, startedByClient: false }, started: false };
    // The host refused this client's connect, so the daemon's state is unknown and it is left alone:
    // the refusal travels to the caller, which names the sandbox and the way out.
    case 'connectDenied':
      throw daemonConnectDeniedError({
        info,
        denial: decision.denial,
        stateDir: settings.paths.baseDir,
      });
    case 'refuseNewer':
      throw await daemonIncompatibleError({
        info,
        mismatch: 'newer',
        stateDir: settings.paths.baseDir,
      });
    case 'replace':
      return decision.cause === 'unreachable'
        ? await replaceUnreachable(settings, info, onStart)
        : await replaceIncompatible(settings, info, onStart);
  }
}

async function replaceUnreachable(
  settings: DaemonClientSettings,
  info: DaemonInfo,
  onStart: EnsureDaemonOptions['onStart'],
): Promise<EnsureStep> {
  // `observeLocalDaemon` probed it repeatedly before calling it unreachable.
  await retireDaemonForTakeover(info, settings.paths);
  return await start(settings, onStart, 'missing', daemonIdentityOf(info));
}

async function replaceIncompatible(
  settings: DaemonClientSettings,
  info: DaemonInfo,
  onStart: EnsureDaemonOptions['onStart'],
): Promise<EnsureStep> {
  // A daemon that predates the capability cannot say whether it is idle, so it is never replaced.
  // One without a recorded start time cannot be addressed by the fence, so it cannot accept either.
  const startTime = info.processStartTime;
  if (!info.capabilities?.includes('quiesce') || !startTime?.trim()) {
    throw await daemonIncompatibleError({
      info,
      mismatch: 'no-quiesce',
      stateDir: settings.paths.baseDir,
    });
  }
  const outcome = await quiesceOrRetireUnresponsive(info, settings);
  if (outcome === 'gone') return { kind: 'judge-again' };
  const drained =
    outcome === 'draining' ? await awaitDrainedDaemon(info, startTime, settings) : outcome;
  // A daemon force-retired for answering nothing is reported like an unreachable one: it was never
  // shown to be idle, so "incompatible" would overstate what happened to it.
  const reason = drained === 'retired' ? 'missing' : 'incompatible';
  return await start(settings, onStart, reason, daemonIdentityOf(info));
}

/**
 * Waits for a daemon that accepted the quiesce request to finish leaving, and signals nothing while
 * it does. A healthy drain runs its own teardown (plugin disposal, lease finalization, registration
 * cleanup), which a signal would cut short or, on Windows, skip entirely.
 *
 * Only a daemon still alive after the deadline is escalated, and only if it answers no liveness
 * probe. A retirement signals only a process whose command line is a daemon entry (see
 * `stopDaemonProcess`), so a process whose identity cannot be proven to be a daemon, such as an
 * embedded host registered by some other process, is never signaled here: it ends in
 * `daemon-drain-timeout` instead.
 */
async function awaitDrainedDaemon(
  info: DaemonInfo,
  startTime: string,
  settings: DaemonClientSettings,
): Promise<'left' | 'retired'> {
  const { exited } = await waitForDaemonExit(
    { pid: info.pid, startTime },
    { timeoutMs: DAEMON_LEAVE_WAIT_MS, pollMs: DRAIN_POLL_MS },
  );
  if (exited) {
    // The daemon removes its own registration; this only clears what a crashed drain left behind.
    await recoverAbandonedDaemonRegistration({
      paths: settings.paths,
      observed: observedDaemonIdentityOf(info),
    });
    return 'left';
  }
  const liveness = await answersLivenessProbe(info);
  // A connect the host refused says nothing about whether this daemon is hung, so it is not a drain
  // to name: the refusal travels to the caller, which names the sandbox and the way out.
  if (liveness.denial) {
    throw daemonConnectDeniedError({
      info,
      denial: liveness.denial,
      stateDir: settings.paths.baseDir,
    });
  }
  if (liveness.reachable) throw await daemonDrainTimeoutError(info, settings);
  const retirement = await stopDaemonForTakeover(info, settings.paths, 'force');
  if (retirement.status !== 'retained') return 'retired';
  // Nothing was signaled because the process could not be proved to be a daemon of its own: either its
  // start time or command line is unreadable, or the record states an owner this build cannot read.
  // That is the drain's own outcome: it is still leaving, or already gone, and nobody knows which. A
  // refusal that names an owner instead (a host that ended up holding this state directory mid-drain)
  // is a replacement that could not be confirmed, and reports as one.
  const refusedReason =
    retirement.termination?.status === 'retained' ? retirement.termination.reason : undefined;
  if (refusedReason === 'identity-unverified' || refusedReason === 'owner-unproven') {
    throw await daemonDrainTimeoutError(info, settings);
  }
  throw daemonRetirementUnconfirmedError(retirement, settings.paths);
}

/**
 * The one place a request timeout can lead to killing a daemon: a quiesce that timed out, against
 * a daemon that then fails its liveness probe every time, is a hung process nobody can ask to leave.
 */
async function quiesceOrRetireUnresponsive(
  info: DaemonInfo,
  settings: DaemonClientSettings,
): Promise<'draining' | 'gone' | 'retired'> {
  try {
    return (await requestDaemonLifecycle(info, settings)).outcome;
  } catch (error) {
    if (
      !(error instanceof AppError) ||
      error.details?.reason !== DAEMON_TRANSPORT_REASONS.timeout.reason
    )
      throw error;
    const liveness = await answersLivenessProbe(info);
    if (liveness.denial) {
      // The refusal is the finding, not the timeout: a daemon this client cannot reach because the
      // host refused the connect is never force-retired.
      throw daemonConnectDeniedError({
        info,
        denial: liveness.denial,
        stateDir: settings.paths.baseDir,
      });
    }
    if (liveness.reachable) throw error;
    await retireDaemonForTakeover(info, settings.paths, 'force');
    return 'retired';
  }
}

async function start(
  settings: DaemonClientSettings,
  onStart: EnsureDaemonOptions['onStart'],
  reason: 'missing' | 'incompatible',
  previous?: DaemonIdentity,
): Promise<EnsureStep> {
  let daemon: EnsuredDaemon;
  try {
    daemon = await startLocalDaemon(settings);
  } catch (error) {
    // The winner of a startup race is judged again from the top, so an incompatible one is quiesced
    // rather than retired.
    if (
      error instanceof AppError &&
      error.details?.reason === DAEMON_UNAVAILABLE_REASONS.contended.reason
    ) {
      return { kind: 'judge-again' };
    }
    throw error;
  }
  // A start can resolve to a daemon another caller raced in, which this call did not start.
  if (daemon.startedByClient) onStart?.(reason, previous);
  return { kind: 'connected', daemon, started: daemon.startedByClient };
}
