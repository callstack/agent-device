import type { DaemonIdentity } from '@agent-device/contracts/client';
import {
  DAEMON_QUIESCE_REASONS,
  type DaemonQuiesceCensus,
} from '@agent-device/daemon-contracts/daemon-resolution';
import { AppError } from '@agent-device/kernel/errors';
import { shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';
import { readVersion } from '@agent-device/host-kit/version';
import type { DaemonInfo } from './daemon-client-metadata.ts';
import { resolveLocalDaemonCodeIdentity, type DaemonTakeoverCause } from './daemon-launch-spec.ts';

// The three ways an explicit lifecycle stops short of a usable daemon. Callers branch on
// `details.reason`, so each reason is one constant here and the messages are free to change.
const DAEMON_LIFECYCLE_REASONS = {
  notRunning: 'daemon-not-running',
  incompatible: 'daemon-incompatible',
  busy: DAEMON_QUIESCE_REASONS.busy,
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
    reason: DAEMON_LIFECYCLE_REASONS.notRunning,
    stateDir,
    ...(registered ? { daemon: daemonIdentityOf(registered) } : {}),
    hint: `Start one with a local agent-device command that uses the daemon (devices, for example), or with ensureDaemon({ stateDir: ${JSON.stringify(stateDir)} }) from the SDK, before attaching.${registered ? ` The registered daemon (pid ${registered.pid}) does not answer; ${daemonStopCommand(stateDir)} clears it.` : ''}`,
  });
}

export async function daemonIncompatibleError(params: {
  info: DaemonInfo;
  mismatch: DaemonTakeoverCause | 'newer' | 'no-quiesce';
  stateDir: string;
}): Promise<AppError> {
  const { info, mismatch, stateDir } = params;
  return new AppError('COMMAND_FAILED', 'The running daemon cannot serve this client.', {
    reason: DAEMON_LIFECYCLE_REASONS.incompatible,
    mismatch,
    stateDir,
    daemon: daemonIdentityOf(info),
    client: await readClientIdentity(),
    hint: `Stop it with ${daemonStopCommand(stateDir)}, then retry. SDK clients call ensureDaemon() to start a compatible one.`,
  });
}

export function daemonBusyError(
  info: DaemonInfo,
  stateDir: string,
  census: DaemonQuiesceCensus | undefined,
): AppError {
  return new AppError('COMMAND_FAILED', 'The running daemon is busy and was not replaced.', {
    reason: DAEMON_LIFECYCLE_REASONS.busy,
    stateDir,
    daemon: daemonIdentityOf(info),
    ...census,
    hint: census?.startingUp
      ? `The daemon is still starting up. Retry in a moment; if it never finishes starting, stop it with ${daemonStopCommand(stateDir)}.`
      : `Wait for its requests, sessions and leases to end and retry, or stop it deliberately with ${daemonStopCommand(stateDir)}.`,
  });
}
