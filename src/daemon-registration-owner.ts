import fs from 'node:fs';
import { readCurrentOwnerIdentity, type OwnerIdentity } from '@agent-device/host-kit/process';
import {
  publishFileSync,
  tryAcquireProcessLock,
  type ProcessLockAttempt,
  type ProcessLockAcquisition,
} from '@agent-device/host-kit/file';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
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

/** Makes one acquisition attempt and binds every daemon write to that acquisition. */
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
    await releaseRegistrationAfterFailure(acquisition, error);
  }
  return {
    status: 'acquired',
    owner: Object.freeze({
      publish(fields: DaemonRegistrationFields) {
        acquisition.assertHeld();
        publishFileSync({ destination: boundPaths.logPath, contents: '', mode: 0o600 });
        const transport =
          fields.socketPort && fields.httpPort ? 'dual' : fields.httpPort ? 'http' : 'socket';
        acquisition.assertHeld();
        publishFileSync({
          destination: boundPaths.infoPath,
          contents: JSON.stringify(
            {
              port: fields.socketPort,
              httpPort: fields.httpPort,
              transport,
              token: fields.token,
              pid: identity.pid,
              version: fields.version,
              codeOrigin: fields.codeOrigin,
              codeSignature: fields.codeSignature,
              processStartTime: identity.startTime ?? undefined,
              policyDigest: fields.policyDigest,
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
          return await releaseRegistrationAfterFailure(acquisition, error);
        }
        await acquisition.release();
        return removal;
      },
    }),
  };
}

function removeRegistrationUnderLock(
  infoPath: string,
  identity: OwnerIdentity,
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
): Promise<never> {
  try {
    await acquisition.release();
  } catch (releaseError) {
    emitDiagnostic({
      level: 'warn',
      phase: 'daemon_registration_release_failed',
      data: { error: String(releaseError) },
    });
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
  acquisition.assertHeld();
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
}
