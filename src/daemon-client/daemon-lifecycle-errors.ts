import type { DaemonIdentity } from '@agent-device/contracts/client';
import {
  DAEMON_LIFECYCLE_REASONS,
  DAEMON_RECORD_OWNER_UNRECOGNIZED_REASON,
  type DaemonLifecycleCensus,
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
    return daemonNotRetirableError({ info, stateDir: paths.baseDir });
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

/** Refuses replacement of a runtime whose host owns its lifetime. */
export function daemonNotRetirableError(params: { info: DaemonInfo; stateDir: string }): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'A host process owns this daemon, so it was not replaced.',
    {
      reason: DAEMON_LIFECYCLE_REASONS.ownerEmbedded,
      stateDir: params.stateDir,
      daemon: daemonIdentityOf(params.info),
      hint: 'Close the host that started this runtime.',
    },
  );
}
