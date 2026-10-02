import fs from 'node:fs';
import { normalizeError, type NormalizedError } from '@agent-device/kernel/errors';
import {
  stopDaemonProcess,
  waitForDaemonExit,
  type DaemonTerminationResult,
} from './daemon-process.ts';
import { readCurrentOwnerIdentity, type OwnerIdentity } from '@agent-device/host-kit/process';
import {
  publishFileSync,
  tryAcquireProcessLock,
  acquireProcessLockAcquisition,
  type ProcessLockAttempt,
  type ProcessLockAcquisition,
} from '@agent-device/host-kit/file';
import { emitDiagnostic, withDiagnosticsScope } from '@agent-device/host-kit/diagnostics';
import type { DaemonCodeOrigin } from '@agent-device/host-kit/code-signature';
import type { DaemonPaths } from './daemon-resolution.ts';
import {
  readRegisteredDaemonOwnership,
  type RegisteredDaemonOwnership,
} from './daemon-registration.ts';
import {
  buildDaemonShutdownReport,
  resolveDaemonShutdownReportPath,
  type DaemonShutdownOutcome,
} from './daemon-shutdown-report.ts';

export const DAEMON_STARTUP_EXIT_CODES = Object.freeze({ busy: 75, unproven: 78 });
export type DaemonRegistrationFields = Readonly<{
  socketPort?: number;
  httpPort?: number;
  token: string;
  version: string;
  codeOrigin: DaemonCodeOrigin;
  codeSignature: string;
  policyDigest?: string;
}>;
type DaemonRegistrationRemoval =
  | Readonly<{ state: 'removed' }>
  | Exclude<RegisteredDaemonOwnership, { state: 'match' }>;
export type DaemonRegistrationOwner = Readonly<{
  publish(fields: DaemonRegistrationFields): void;
  finish(outcome?: DaemonShutdownOutcome): Promise<DaemonRegistrationRemoval>;
}>;

export async function tryAcquireDaemonRegistration(
  paths: DaemonPaths,
): Promise<
  | Readonly<{ status: 'acquired'; owner: DaemonRegistrationOwner }>
  | Exclude<ProcessLockAttempt, { status: 'acquired' }>
> {
  const boundPaths = { ...paths };
  const identity = readCurrentOwnerIdentity();
  const attempt = tryAcquireProcessLock({
    lockDirPath: boundPaths.lockPath,
    owner: { ...identity, acquiredAtMs: Date.now() },
    description: 'daemon registration',
  });
  if (attempt.status !== 'acquired') return attempt;
  const { acquisition } = attempt;
  try {
    acquisition.assertHeld();
    fs.rmSync(resolveDaemonShutdownReportPath(boundPaths.baseDir), { force: true });
  } catch (error) {
    await releaseRegistrationAfterFailure(acquisition, error, boundPaths.logPath);
  }
  return {
    status: 'acquired',
    owner: Object.freeze({
      publish({ socketPort, httpPort, ...fields }: DaemonRegistrationFields) {
        acquisition.assertHeld();
        truncateDaemonLog(boundPaths.logPath);
        const transport = socketPort && httpPort ? 'dual' : httpPort ? 'http' : 'socket';
        acquisition.assertHeld();
        publishFileSync({
          destination: boundPaths.infoPath,
          contents: JSON.stringify(
            {
              ...fields,
              port: socketPort,
              httpPort,
              transport,
              pid: identity.pid,
              processStartTime: identity.startTime ?? undefined,
              stateDir: boundPaths.baseDir,
            },
            null,
            2,
          ),
          mode: 0o600,
        });
      },
      async finish(outcome?: DaemonShutdownOutcome) {
        let removal: DaemonRegistrationRemoval;
        try {
          if (outcome) writeShutdownReport(boundPaths.baseDir, outcome, acquisition);
          removal = removeRegistrationUnderLock(boundPaths.infoPath, identity, acquisition);
        } catch (error) {
          return await releaseRegistrationAfterFailure(acquisition, error, boundPaths.logPath);
        }
        await acquisition.release();
        return removal;
      },
    }),
  };
}

function removeRegistrationUnderLock(
  infoPath: string,
  identity: OwnerIdentity | null,
  acquisition: ProcessLockAcquisition,
): DaemonRegistrationRemoval {
  acquisition.assertHeld();
  const ownership = readRegisteredDaemonOwnership(infoPath, identity);
  if (ownership.state !== 'match') return ownership;
  acquisition.assertHeld();
  try {
    fs.unlinkSync(infoPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { state: 'removed' };
}

async function releaseRegistrationAfterFailure(
  acquisition: ProcessLockAcquisition,
  error: unknown,
  logPath: string,
): Promise<never> {
  try {
    await acquisition.release();
  } catch (releaseError) {
    await recordRegistrationWarning(logPath, 'daemon_registration_release_failed', releaseError);
  }
  throw error;
}

function writeShutdownReport(
  stateDir: string,
  outcome: DaemonShutdownOutcome,
  acquisition: ProcessLockAcquisition,
): void {
  const filePath = resolveDaemonShutdownReportPath(stateDir);
  const contents = `${JSON.stringify(buildDaemonShutdownReport(outcome))}\n`;
  acquisition.assertHeld();
  try {
    publishFileSync({ destination: filePath, contents, mode: 0o600 });
  } catch {
    return;
  }
}

/** The daemon's stdout and stderr append to this inode, so it is emptied in place, never replaced. */
function truncateDaemonLog(logPath: string): void {
  const descriptor = fs.openSync(logPath, 'a', 0o600);
  try {
    fs.ftruncateSync(descriptor, 0);
  } finally {
    fs.closeSync(descriptor);
  }
}

export type DaemonRetirementInput = Readonly<{
  paths: DaemonPaths;
  observed: OwnerIdentity | null;
  termTimeoutMs?: number;
  killTimeoutMs?: number;
  lockTimeoutMs?: number;
}>;

type ConfirmedDaemonTermination = Extract<DaemonTerminationResult, { status: 'exited' }>;
export type DaemonRetirementResult =
  | Readonly<{ status: 'retired'; termination: ConfirmedDaemonTermination; removedInfo: boolean }>
  | Readonly<{ status: 'absent'; removedInfo: false }>
  | Readonly<{
      status: 'retained';
      termination?: DaemonTerminationResult;
      removedInfo: boolean;
      reason:
        | 'ownership-unproven'
        | 'exit-unconfirmed'
        | 'stop-failed'
        | 'lock-busy'
        | 'registration-replaced'
        | 'metadata-unreadable'
        | 'retirement-unconfirmed';
      error?: NormalizedError;
    }>;

/** Stops only the captured daemon lifetime, then retires its registration under the startup lock. */
export async function stopAndRetireDaemon(
  input: DaemonRetirementInput & Readonly<{ mode: 'graceful' | 'force' }>,
): Promise<DaemonRetirementResult> {
  return await retireObservedDaemon(input, (identity) =>
    stopDaemonProcess(identity, {
      mode: input.mode,
      termTimeoutMs: input.termTimeoutMs ?? 3_000,
      killTimeoutMs: input.killTimeoutMs ?? 1_000,
    }),
  );
}

/** Recovers a confirmed abandoned registration without signaling a live process. */
export async function recoverAbandonedDaemonRegistration(
  input: DaemonRetirementInput,
): Promise<DaemonRetirementResult> {
  return await retireObservedDaemon(input, async (identity) => {
    if (!identity.startTime?.trim()) return { status: 'retained', reason: 'missing-start-time' };
    const confirmed = { pid: identity.pid, startTime: identity.startTime };
    return (await waitForDaemonExit(confirmed, { timeoutMs: 0 })).exited
      ? { status: 'exited', identity: confirmed, mode: 'already-exited' }
      : { status: 'retained', reason: 'identity-unverified' };
  });
}

async function retireObservedDaemon(
  input: DaemonRetirementInput,
  terminate: (identity: OwnerIdentity) => Promise<DaemonTerminationResult>,
): Promise<DaemonRetirementResult> {
  const paths = { ...input.paths };
  const observed = input.observed && { ...input.observed };
  let termination: ConfirmedDaemonTermination | undefined;
  if (observed) {
    try {
      const result = await terminate(observed);
      if (result.status !== 'exited')
        return {
          status: 'retained',
          reason: 'exit-unconfirmed',
          termination: result,
          removedInfo: false,
        };
      termination = result;
    } catch (error) {
      return {
        status: 'retained',
        reason: 'stop-failed',
        removedInfo: false,
        error: normalizeError(error),
      };
    }
  }
  return await retireDaemonRegistration({ ...input, paths }, termination);
}

async function retireDaemonRegistration(
  input: DaemonRetirementInput,
  termination: ConfirmedDaemonTermination | undefined,
): Promise<DaemonRetirementResult> {
  const paths = input.paths;
  let acquisition: ProcessLockAcquisition;
  try {
    acquisition = await acquireProcessLockAcquisition({
      lockDirPath: paths.lockPath,
      owner: { ...readCurrentOwnerIdentity(), acquiredAtMs: Date.now() },
      description: 'daemon registration retirement',
      timeoutMs: input.lockTimeoutMs ?? 1_000,
    });
  } catch (error) {
    const failure = normalizeError(error);
    return {
      status: 'retained',
      reason:
        failure.details?.reason === 'process_lock_timeout' ? 'lock-busy' : 'retirement-unconfirmed',
      termination,
      removedInfo: false,
      error: failure,
    };
  }
  let result: DaemonRetirementResult;
  try {
    const removal = removeRegistrationUnderLock(
      paths.infoPath,
      termination?.identity ?? null,
      acquisition,
    );
    result = retirementAfterRemoval(removal, termination);
  } catch (error) {
    result = {
      status: 'retained',
      reason: 'retirement-unconfirmed',
      termination,
      removedInfo: false,
      error: normalizeError(error),
    };
  }
  return await releaseAfterRetirement(acquisition, result, paths.logPath);
}

async function releaseAfterRetirement(
  acquisition: ProcessLockAcquisition,
  result: DaemonRetirementResult,
  logPath: string,
): Promise<DaemonRetirementResult> {
  try {
    await acquisition.release();
  } catch (error) {
    const primary = result.status === 'retained' ? result.error : undefined;
    if (primary)
      await recordRegistrationWarning(logPath, 'daemon_retirement_release_failed', error);
    result = {
      ...result,
      status: 'retained',
      reason: 'retirement-unconfirmed',
      error: primary ?? normalizeError(error),
    };
  }
  return result;
}

function retirementAfterRemoval(
  removal: DaemonRegistrationRemoval,
  termination: ConfirmedDaemonTermination | undefined,
): DaemonRetirementResult {
  if (termination && (removal.state === 'removed' || removal.state === 'absent')) {
    return { status: 'retired', termination, removedInfo: removal.state === 'removed' };
  }
  if (removal.state === 'absent') return { status: 'absent', removedInfo: false };
  return {
    status: 'retained',
    termination,
    removedInfo: false,
    reason:
      removal.state === 'replaced'
        ? 'registration-replaced'
        : removal.state === 'unreadable'
          ? 'metadata-unreadable'
          : 'ownership-unproven',
  };
}

async function recordRegistrationWarning(
  logPath: string,
  phase: string,
  error: unknown,
): Promise<void> {
  await withDiagnosticsScope({ command: 'daemon', session: 'daemon', logPath, debug: true }, () => {
    emitDiagnostic({ level: 'warn', phase, data: { error: normalizeError(error) } });
  });
}
