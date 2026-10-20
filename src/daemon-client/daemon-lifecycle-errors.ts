import type { DaemonIdentity } from '@agent-device/contracts/client';
import {
  DAEMON_LIFECYCLE_REASONS,
  DAEMON_RECORD_OWNER_UNRECOGNIZED_REASON,
  type DaemonLifecycleCensus,
  type DaemonOwnership,
  type DaemonPaths,
} from '@agent-device/daemon-contracts/daemon-resolution';
import type { DaemonRetirementResult } from '@agent-device/daemon-contracts/daemon-registration-owner';
import { AppError } from '@agent-device/kernel/errors';
import { shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';
import { readVersion } from '@agent-device/host-kit/version';
import type { DaemonClientSettings } from './daemon-client-lifecycle.ts';
import {
  getDaemonMetadataState,
  resolveDaemonStartupHint,
  type DaemonInfo,
} from './daemon-client-metadata.ts';
import { resolveLocalDaemonCodeIdentity, type DaemonTakeoverCause } from './daemon-launch-spec.ts';

// The ways an explicit lifecycle stops short of a usable daemon, whether this client judged it or the
// daemon answered it: `busy` is the daemon's own refusal, carried through so one constant names it on
// both sides. Callers branch on `details.reason`, so each reason is one constant here and the messages
// are free to change.
const DAEMON_UNAVAILABLE_REASONS = {
  notRunning: 'daemon-not-running',
  incompatible: 'daemon-incompatible',
  busy: DAEMON_LIFECYCLE_REASONS.busy,
  drainTimeout: 'daemon-drain-timeout',
} as const;

export function daemonIdentityOf(info: DaemonInfo): DaemonIdentity {
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

/** A daemon won a startup race that this caller may not settle by retiring it. */
export const DAEMON_CONTENDED_REASON = 'daemon-contended';

export function daemonContendedError(): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'Another process started a daemon while this one was starting.',
    {
      reason: DAEMON_CONTENDED_REASON,
    },
  );
}

export function daemonNotRunningError(stateDir: string, registered?: DaemonInfo): AppError {
  return new AppError('COMMAND_FAILED', 'No daemon is running for this state directory.', {
    reason: DAEMON_UNAVAILABLE_REASONS.notRunning,
    stateDir,
    ...(registered ? { daemon: daemonIdentityOf(registered) } : {}),
    hint: `Start one with a local agent-device command that uses the daemon (agent-device devices --state-dir ${shellQuoteIfNeeded(stateDir)}, for example), or with ensureDaemon({ stateDir: ${JSON.stringify(stateDir)} }) from the SDK, before attaching.${registered ? ` The registered daemon (pid ${registered.pid}) does not answer; ${daemonStopCommand(stateDir)} clears it.` : ''}`,
  });
}

export function daemonRetirementUnconfirmedError(
  retirement: Extract<DaemonRetirementResult, { status: 'retained' }>,
  paths: DaemonPaths,
): AppError {
  return new AppError('COMMAND_FAILED', 'Daemon replacement could not be confirmed.', {
    reason: 'daemon_retirement_unconfirmed',
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
    return daemonNotRetirableError({ info, stateDir: paths.baseDir, owner: 'embedded' });
  if (retirement.reason === 'owner-unproven')
    return daemonRecordOwnerUnrecognizedError({ info, stateDir: paths.baseDir });
  return daemonRetirementUnconfirmedError(retirement, paths);
}

export function isDaemonNotRunningError(error: unknown): boolean {
  return (
    error instanceof AppError && error.details?.reason === DAEMON_UNAVAILABLE_REASONS.notRunning
  );
}

export async function daemonIncompatibleError(params: {
  info: DaemonInfo;
  mismatch: DaemonTakeoverCause | 'newer' | 'no-quiesce';
  stateDir: string;
}): Promise<AppError> {
  const { info, mismatch, stateDir } = params;
  return new AppError('COMMAND_FAILED', 'The running daemon cannot serve this client.', {
    reason: DAEMON_UNAVAILABLE_REASONS.incompatible,
    mismatch,
    stateDir,
    daemon: daemonIdentityOf(info),
    client: await readClientIdentity(),
    hint: `Stop it with ${daemonStopCommand(stateDir)}, then retry. SDK clients call ensureDaemon() to start a compatible one.`,
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
      reason: DAEMON_UNAVAILABLE_REASONS.drainTimeout,
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
    reason: DAEMON_UNAVAILABLE_REASONS.busy,
    stateDir,
    daemon: daemonIdentityOf(info),
    ...census,
    hint: census?.startingUp
      ? `The daemon is still starting up. Retry in a moment; if it never finishes starting, stop it with ${daemonStopCommand(stateDir)}.`
      : `Wait for its requests, sessions and leases to end and retry, or stop it deliberately with ${daemonStopCommand(stateDir)}.`,
  });
}

/** Refuses managed replacement when the record cannot prove a detached owner. */
function daemonRecordOwnerUnrecognizedError(params: {
  info: DaemonInfo;
  stateDir: string;
}): AppError {
  const { info, stateDir } = params;
  return new AppError(
    'COMMAND_FAILED',
    'This daemon record states an owner this version cannot read, so its daemon was not replaced.',
    {
      reason: DAEMON_RECORD_OWNER_UNRECOGNIZED_REASON,
      stateDir,
      daemon: daemonIdentityOf(info),
      hint: `Update agent-device if the record comes from a newer build. Otherwise check what owns pid ${info.pid}, then repair the record: stop that process by its own means and remove ${shellQuoteIfNeeded(stateDir)}/daemon.json so a daemon can register again.`,
    },
  );
}

/**
 * A caller wanted this daemon gone, and its owner's rule says otherwise: a host process owns an
 * embedded runtime and ends it, and a detached daemon is stopped by signalling its own process, which is
 * what `daemon stop` does for a record that proves that owner.
 *
 * Both cases mean the same thing to a caller: this daemon is not yours to retire. `owner` is the
 * daemon's own answer about itself, so it is trusted over this process's read of the record — except for
 * the hint, which reads the record too. A detached answer against a record this build cannot place is a
 * corrupt state directory, and `daemon stop` refuses that record for the same reason this client just
 * did, so its hint names the record repair instead of sending the operator to a second refusal.
 */
export function daemonNotRetirableError(params: {
  info: DaemonInfo;
  stateDir: string;
  owner: Exclude<DaemonOwnership, 'unknown'>;
}): AppError {
  const { info, stateDir, owner } = params;
  const embedded = owner === 'embedded';
  const recordUnreadable = !embedded && info.ownership === 'unknown';
  return new AppError(
    'COMMAND_FAILED',
    embedded
      ? 'A host process owns this daemon, so it was not replaced.'
      : 'This daemon is not embedder-owned, so a shutdown request is not how it is stopped.',
    {
      reason: embedded
        ? DAEMON_LIFECYCLE_REASONS.ownerEmbedded
        : DAEMON_LIFECYCLE_REASONS.notEmbedded,
      stateDir,
      daemon: daemonIdentityOf(info),
      hint: embedded
        ? `Close the host that started it, or ask this daemon to leave with ${daemonStopCommand(stateDir)}, which sends it a shutdown request instead of a signal.`
        : recordUnreadable
          ? `The daemon says it is a daemon of its own, so the owner its record states is wrong. Nothing was signaled. Check what owns pid ${info.pid}, then repair the record: stop that process by its own means and remove ${shellQuoteIfNeeded(stateDir)}/daemon.json so a daemon can register again.`
          : `Stop it with ${daemonStopCommand(stateDir)}.`,
    },
  );
}
