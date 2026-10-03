import fs from 'node:fs';
import path from 'node:path';
import { normalizeError } from '@agent-device/kernel/errors';
import { stopDaemonProcess } from '../../../src/daemon-process.ts';

type TestDaemonIdentity = { pid: number; processStartTime?: string };

/** Best-effort cleanup keeps primary test failures and unconfirmed daemon state. */
export async function cleanupDaemonTestState(
  stateDir: string,
  observed: TestDaemonIdentity | null,
): Promise<void> {
  try {
    const identity = observed ?? readIdentity(stateDir);
    if (!identity) throw new Error('No daemon lifetime was observed');
    const termination = await stopDaemonProcess(
      { pid: identity.pid, startTime: identity.processStartTime ?? null },
      { mode: 'graceful', termTimeoutMs: 1_500, killTimeoutMs: 1_500 },
    );
    if (termination.status !== 'exited') {
      console.warn('Daemon test cleanup retained state:', stateDir, termination);
      return;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  } catch (error) {
    console.warn('Daemon test cleanup retained state:', stateDir, normalizeError(error));
  }
}

function readIdentity(stateDir: string): TestDaemonIdentity | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(stateDir, 'daemon.json'), 'utf8'),
    ) as TestDaemonIdentity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
