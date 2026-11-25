import fs from 'node:fs';
import type { ProcessLockInspection } from '@agent-device/host-kit/file';
import type { DaemonIdentity } from '@agent-device/contracts/client';
import {
  DAEMON_LIFECYCLE_REASONS,
  embeddedCloseHint,
  DAEMON_RETIREMENT_REASONS,
  type DaemonLifecycleCensus,
  type DaemonPaths,
} from '@agent-device/daemon-contracts/daemon-resolution';
import type { DaemonRetirementResult } from '@agent-device/daemon-contracts/daemon-registration-owner';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import { shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';
import { readVersion } from '@agent-device/host-kit/version';
import type { DaemonClientSettings } from './daemon-client-lifecycle.ts';
import type { DaemonInfo, DaemonTakeoverCause } from './daemon-client-metadata.ts';
import type { LoopbackConnectDenial } from './daemon-client-loopback-probe.ts';
import { resolveLocalDaemonCodeIdentity } from './daemon-launch-spec.ts';

// The ways an explicit lifecycle stops short of a usable daemon, as this client judges it. A busy
// daemon answers with its own `DAEMON_LIFECYCLE_REASONS.busy`, which this client carries through.
export const DAEMON_UNAVAILABLE_REASONS = {
  // An attaching client found no daemon to connect to.
  notRunning: { reason: 'daemon-not-running' },
  // The running daemon does not match the client; `details.daemon` and `details.client` hold both
  // identities.
  incompatible: { reason: 'daemon-incompatible' },
  // A daemon accepted the request to leave but was still running 60 s later and could not be
  // retired.
  drainTimeout: { reason: 'daemon-drain-timeout' },
  // Another process started a daemon while this one was starting, and this caller may not retire a
  // daemon it never started.
  contended: { reason: 'daemon-contended' },
  // The daemon kept being started or replaced while `ensureDaemon` was judging the state directory.
  lifecycleContended: { reason: 'daemon-lifecycle-contended' },
  // A daemon this client started did not prove through its registration that it owns the process.
  registrationUnproven: { reason: 'daemon_registration_unproven' },
  // The `daemon.json` of the state directory cannot identify a usable daemon, so nothing was
  // started, replaced, or signaled.
  recordUnreadable: { reason: 'daemon-record-unreadable' },
  // The health probe that gates a remote send found no daemon to hand the request to, so
  // `details.dispatched` is `no` and a resend is safe.
  remoteUnavailable: { reason: 'remote_daemon_unavailable' },
  // A client pinned to one daemon instance reached a state directory registering another one, or
  // none it can read as an address; `details.bound` and `details.registered` hold both.
  bindingMismatch: { reason: 'daemon-binding-mismatch' },
  // The running daemon enforces a different daemon policy than `AGENT_DEVICE_DAEMON_POLICY` names.
  policyMismatch: { reason: 'DAEMON_POLICY_MISMATCH' },
  // The daemon process ended before it registered a reachable endpoint, for a cause other than a
  // denied loopback listen.
  startupExited: { reason: 'startup-exited' },
  // The daemon process ended because the host refused its loopback listen, as a sandbox around the
  // launching command does.
  startupListenDenied: { reason: 'startup-listen-denied' },
  // The host refused this client's loopback connect to the registered daemon with `EPERM` or `EACCES`,
  // as a sandbox around it does; `details.daemon` names the daemon left alone. A connect that failed
  // with another errno is ordinary unreachability.
  connectDenied: { reason: 'daemon-connect-denied' },
  // The daemon stayed registered and reachable but never reported the startup phase that follows.
  startupStalled: { reason: 'startup-stalled' },
  // Startup passed the ceiling its own startup budget allows, so this client stopped waiting.
  startupCeiling: { reason: 'startup-ceiling' },
} as const satisfies ReasonTable<'daemon lifecycle'>;

// What a client configuration can refuse before it ever reaches a daemon.
export const DAEMON_CLIENT_CONFIG_REASONS = {
  // The client named both a pinned daemon instance and a daemon base URL, which answer "which
  // daemon" two different ways.
  bindingWithBaseUrl: { reason: 'daemon_binding_with_remote_base_url' },
} as const satisfies ReasonTable<'daemon lifecycle'>;

export function daemonIdentityOf(info: DaemonIdentity): DaemonIdentity {
  return {
    pid: info.pid,
    ...(info.version !== undefined ? { version: info.version } : {}),
    ...(info.codeOrigin !== undefined ? { codeOrigin: info.codeOrigin } : {}),
    ...(info.codeSignature !== undefined ? { codeSignature: info.codeSignature } : {}),
    ...(info.processStartTime !== undefined ? { processStartTime: info.processStartTime } : {}),
  };
}

async function readClientIdentity(): Promise<Omit<DaemonIdentity, 'pid' | 'processStartTime'>> {
  const code = await resolveLocalDaemonCodeIdentity();
  return {
    version: readVersion(),
    codeOrigin: code.origin,
    ...(code.origin === 'checkout' ? { codeSignature: code.codeSignature } : {}),
  };
}

/** The command that ends a daemon deliberately; the one recovery every surface can name. */
export function daemonStopCommand(stateDir: string): string {
  return `agent-device daemon stop --state-dir ${shellQuoteIfNeeded(stateDir)}`;
}

/**
 * The refusal both remote-send gates answer with: the probe before the first send
 * (`ensureRemoteDaemon`) and the probe a restart retry runs after the daemon instance changed under
 * the request. Before the first send, the request never leaves the client. On the restart retry, the
 * first request did reach the daemon, but it refused it with the instance-mismatch precondition
 * before running it, and the retry is withheld. So `dispatched: 'no'` states that the command did
 * not run — what makes a resend safe, for a UI action as much as for a read — and a caller branches
 * on the reason instead of comparing the message. `attempts` counts the gate's probes, more than
 * one when it re-probed within the command's budget. `healthRecoveryBudgetMs` is present only when
 * that budget ran out, which tells a spent budget from a single failed probe.
 */
export function remoteDaemonUnavailableError(params: {
  daemonBaseUrl: string | undefined;
  attempts: number;
  healthRecoveryBudgetMs?: number;
  hint?: string;
}): AppError {
  const { daemonBaseUrl, attempts, healthRecoveryBudgetMs, hint } = params;
  return new AppError('COMMAND_FAILED', 'Remote daemon is unavailable', {
    reason: DAEMON_UNAVAILABLE_REASONS.remoteUnavailable.reason,
    dispatched: 'no',
    daemonBaseUrl,
    attempts,
    ...(healthRecoveryBudgetMs !== undefined ? { healthRecoveryBudgetMs } : {}),
    ...(hint !== undefined ? { hint } : {}),
  });
}

/** A daemon won a startup race that this caller may not settle by retiring it. */
export function daemonContendedError(): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'Another process started a daemon while this one was starting.',
    {
      reason: DAEMON_UNAVAILABLE_REASONS.contended.reason,
    },
  );
}

export function daemonNotRunningError(stateDir: string, registered?: DaemonInfo): AppError {
  return new AppError('COMMAND_FAILED', 'No daemon is running for this state directory.', {
    reason: DAEMON_UNAVAILABLE_REASONS.notRunning.reason,
    stateDir,
    ...(registered ? { daemon: daemonIdentityOf(registered) } : {}),
    hint: `Start one with a local agent-device command that uses the daemon (agent-device devices --state-dir ${shellQuoteIfNeeded(stateDir)}, for example), or with ensureDaemon({ stateDir: ${JSON.stringify(stateDir)} }) from the SDK, before attaching.${registered ? ` The registered daemon (pid ${registered.pid}) does not answer. ${registered.ownership === 'embedded' ? embeddedCloseHint(registered.pid) : `${daemonStopCommand(stateDir)} clears it.`}` : ''}`,
  });
}

export function daemonRetirementUnconfirmedError(
  retirement: Extract<DaemonRetirementResult, { status: 'retained' }>,
  paths: DaemonPaths,
): AppError {
  return new AppError('COMMAND_FAILED', 'Daemon replacement could not be confirmed.', {
    reason: DAEMON_RETIREMENT_REASONS.retirementUnconfirmed.reason,
    retirement,
    hint: retirement.error?.hint ?? resolveDaemonStartupHint(getDaemonMetadataState(paths), paths),
  });
}

/**
 * The refusal a takeover reports when its retirement kept the state, keyed on the reason that retirement
 * gives for itself. Ownership is judged inside the retirement, so this is the one place that answer
 * becomes a client error: an owner's rule keeps the reason every other surface uses for that owner, and
 * anything else stays a replacement this client could not confirm.
 */
export function daemonTakeoverRetirementError(
  retirement: Extract<DaemonRetirementResult, { status: 'retained' }>,
  info: DaemonInfo,
  paths: DaemonPaths,
): AppError {
  if (retirement.reason === 'embedded-owner')
    return daemonNotRetirableError({ info, stateDir: paths.baseDir });
  if (retirement.reason === 'owner-unproven')
    return daemonRecordOwnerUnrecognizedError({ info, stateDir: paths.baseDir });
  return daemonRetirementUnconfirmedError(retirement, paths);
}

export function isDaemonNotRunningError(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.details?.reason === DAEMON_UNAVAILABLE_REASONS.notRunning.reason
  );
}

export async function daemonIncompatibleError(params: {
  info: DaemonInfo;
  mismatch: DaemonTakeoverCause | 'newer' | 'no-quiesce';
  stateDir: string;
}): Promise<AppError> {
  const { info, mismatch, stateDir } = params;
  return new AppError('COMMAND_FAILED', 'The running daemon cannot serve this client.', {
    reason: DAEMON_UNAVAILABLE_REASONS.incompatible.reason,
    mismatch,
    stateDir,
    daemon: daemonIdentityOf(info),
    client: await readClientIdentity(),
    hint:
      info.ownership === 'embedded'
        ? embeddedCloseHint(info.pid)
        : `Stop it with ${daemonStopCommand(stateDir)}, then retry. SDK clients call ensureDaemon() to start a compatible one.`,
  });
}

export async function daemonDrainTimeoutError(
  info: DaemonInfo,
  settings: Pick<DaemonClientSettings, 'paths'>,
): Promise<AppError> {
  const stateDir = settings.paths.baseDir;
  return new AppError(
    'COMMAND_FAILED',
    'The daemon accepted the request to leave but is still running.',
    {
      reason: DAEMON_UNAVAILABLE_REASONS.drainTimeout.reason,
      stateDir,
      daemon: daemonIdentityOf(info),
      hint: `It was not signaled. Retry once it has exited, or stop it deliberately with ${daemonStopCommand(stateDir)}.`,
    },
  );
}

export function daemonBusyError(
  info: DaemonInfo,
  stateDir: string,
  census: DaemonLifecycleCensus | undefined,
): AppError {
  return new AppError('COMMAND_FAILED', 'The running daemon is busy and was not replaced.', {
    reason: DAEMON_LIFECYCLE_REASONS.busy.reason,
    stateDir,
    daemon: daemonIdentityOf(info),
    ...census,
    hint: census?.startingUp
      ? `The daemon is still starting up. Retry in a moment; if it never finishes starting, stop it with ${daemonStopCommand(stateDir)}.`
      : `Wait for its requests, sessions and leases to end and retry, or stop it deliberately with ${daemonStopCommand(stateDir)}.`,
  });
}

/**
 * The answer to a loopback endpoint the host refused, whether the daemon's listen or a client's
 * connect. One owner for both: a sandboxed agent reads it to ask for host access instead of giving up.
 */
export const DAEMON_LOOPBACK_DENIED_HINT =
  'The host denied agent-device a loopback port on 127.0.0.1 (connect or listen EPERM or EACCES). ' +
  'A sandbox around this command likely blocks local ports and simulator access. Run agent-device ' +
  "outside the sandbox: allow the agent-device command in the agent's sandbox rules, or rerun it " +
  'with host access (escalated permissions).';

/**
 * The refusal when the host denied this client's connect to the registered daemon. The daemon keeps
 * running: this client saw nothing of it, so it replaced, retired and signaled nothing.
 */
export function daemonConnectDeniedError(params: {
  info: DaemonInfo;
  denial: LoopbackConnectDenial;
  stateDir: string;
}): AppError {
  const { info, denial, stateDir } = params;
  return new AppError(
    'COMMAND_FAILED',
    `The host denied this client a connect to the daemon's loopback endpoint on 127.0.0.1:${denial.port}.`,
    {
      reason: DAEMON_UNAVAILABLE_REASONS.connectDenied.reason,
      stateDir,
      daemon: daemonIdentityOf(info),
      transport: denial.transport,
      port: denial.port,
      errno: denial.errno,
      hint: DAEMON_LOOPBACK_DENIED_HINT,
    },
  );
}

/** Refuses replacement when the record cannot prove a detached owner. */
function daemonRecordOwnerUnrecognizedError(params: {
  info: DaemonIdentity;
  stateDir: string;
}): AppError {
  const { info, stateDir } = params;
  return new AppError(
    'COMMAND_FAILED',
    'This daemon record states an owner this version cannot read, so this client did not replace it.',
    {
      reason: DAEMON_RETIREMENT_REASONS.ownerUnrecognized.reason,
      stateDir,
      daemon: daemonIdentityOf(info),
      hint: `Update agent-device if the record comes from a newer build. Otherwise check what owns pid ${info.pid}, then repair the record: stop that process by its own means and remove ${shellQuoteIfNeeded(stateDir)}/daemon.json so a daemon can register again.`,
    },
  );
}

/** The host that started an embedded runtime owns its close. */
export function daemonNotRetirableError(params: {
  info: DaemonIdentity;
  stateDir: string;
}): AppError {
  const { info, stateDir } = params;
  return new AppError(
    'COMMAND_FAILED',
    'A host process owns this runtime, so it was not retired.',
    {
      reason: DAEMON_LIFECYCLE_REASONS.ownerEmbedded.reason,
      stateDir,
      daemon: daemonIdentityOf(info),
      hint: embeddedCloseHint(info.pid),
    },
  );
}

type DaemonMetadataState = {
  hasInfo: boolean;
  hasLock: boolean;
};

export function getDaemonMetadataState(paths: DaemonPaths): DaemonMetadataState {
  return {
    hasInfo: fs.existsSync(paths.infoPath),
    hasLock: fs.existsSync(paths.lockPath),
  };
}

export function resolveDaemonStartupHint(
  state: { hasInfo: boolean; hasLock: boolean },
  paths: Pick<DaemonPaths, 'infoPath' | 'lockPath'>,
): string {
  const artifacts = [state.hasInfo ? paths.infoPath : null, state.hasLock ? paths.lockPath : null]
    .filter(Boolean)
    .join(' and ');
  return `Daemon startup did not establish a reachable owner. ${artifacts ? `State was retained at ${artifacts}. ` : ''}Read daemon.log in the state directory. Before upgrading, stop all older clients and daemons with their original CLI and prevent them from returning to this state directory. Unverified lock state requires confirming every user stopped before manual recovery; deleting metadata alone is not a safe reset.`;
}

export function daemonRegistrationUnprovenError(
  paths: DaemonPaths,
  inspection?: ProcessLockInspection,
): AppError {
  return new AppError('COMMAND_FAILED', 'Daemon registration ownership could not be verified.', {
    reason: DAEMON_UNAVAILABLE_REASONS.registrationUnproven.reason,
    inspection,
    stateDir: paths.baseDir,
    hint: resolveDaemonStartupHint(getDaemonMetadataState(paths), paths),
  });
}

export function daemonRecordUnreadableError(paths: DaemonPaths): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `The daemon record on ${paths.baseDir} cannot identify a usable daemon.`,
    {
      reason: DAEMON_UNAVAILABLE_REASONS.recordUnreadable.reason,
      stateDir: paths.baseDir,
      hint: 'No daemon was started, replaced or signaled. Inspect the retained record and its ownership before retrying.',
    },
  );
}
