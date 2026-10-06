import fs from 'node:fs';
import { normalizeError } from '@agent-device/kernel/errors';
import { tryAcquireProcessLock } from '@agent-device/host-kit/file';
import {
  readCurrentOwnerIdentity,
  ownerIdentityMatches,
  type OwnerIdentity,
} from '@agent-device/host-kit/process';
import { stopDaemonProcess } from '../../../src/daemon-process.ts';
import { resolveDaemonPaths } from '../../../src/daemon-resolution.ts';
import {
  readRegisteredDaemonIdentity,
  readRegisteredDaemonOwnership,
} from '../../../src/daemon-registration.ts';

type TestDaemonIdentity = { pid: number; processStartTime?: string };

/** Best-effort cleanup keeps primary test failures and unconfirmed daemon state. */
export async function cleanupDaemonTestState(
  stateDir: string,
  observed: TestDaemonIdentity | null,
): Promise<void> {
  try {
    const paths = resolveDaemonPaths(stateDir);
    const identities: OwnerIdentity[] = observed
      ? [{ pid: observed.pid, startTime: observed.processStartTime ?? null }]
      : [];
    let registrationFailure: unknown;
    try {
      const registered = readIdentity(paths.infoPath);
      if (registered) identities.push(registered);
    } catch (error) {
      registrationFailure = error;
    }
    const confirmed: OwnerIdentity[] = [];
    const retained: OwnerIdentity[] = [];
    for (const identity of identities) {
      const termination = await stopDaemonProcess(identity, {
        mode: 'graceful',
        termTimeoutMs: 1_500,
        killTimeoutMs: 1_500,
      });
      if (termination.status === 'exited') confirmed.push(identity);
      else if (termination.status === 'retained') retained.push(identity);
    }
    if (registrationFailure) throw registrationFailure;
    if (
      retained.some(
        (identity) =>
          Boolean(identity.startTime?.trim()) ||
          !confirmed.some((proof) => proof.pid === identity.pid),
      ) ||
      confirmed.length === 0
    )
      throw new Error('Daemon termination could not be confirmed');
    const attempt = tryAcquireProcessLock({
      lockDirPath: paths.lockPath,
      owner: { ...readCurrentOwnerIdentity(), acquiredAtMs: Date.now() },
      description: 'daemon test cleanup',
    });
    if (attempt.status !== 'acquired')
      throw new Error('Daemon registration is held or unproven during test cleanup');
    const { acquisition } = attempt;
    try {
      acquisition.assertHeld();
      const current = readIdentity(paths.infoPath);
      if (current && !confirmed.some((identity) => ownerIdentityMatches(identity, current)))
        throw new Error('Daemon registration changed during test cleanup');
      acquisition.assertHeld();
      fs.rmSync(stateDir, { recursive: true, force: true });
    } finally {
      await acquisition.release();
    }
  } catch (error) {
    console.warn('Daemon test cleanup retained state:', stateDir, normalizeError(error));
  }
}

function readIdentity(infoPath: string): OwnerIdentity | null {
  if (readRegisteredDaemonOwnership(infoPath, null).state === 'absent') return null;
  const identity = readRegisteredDaemonIdentity(infoPath);
  if (!identity) throw new Error('Daemon registration identity is invalid or unreadable');
  return identity;
}
