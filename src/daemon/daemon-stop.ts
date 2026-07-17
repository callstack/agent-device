import fs from 'node:fs';
import { AppError } from '../kernel/errors.ts';
import { isAgentDeviceDaemonProcess, trySignalProcess } from './daemon-process.ts';
import { isProcessAlive, waitForProcessExit } from '../utils/host-process.ts';
import { sleep } from '../utils/timeouts.ts';
import type { DaemonPaths } from './config.ts';
import type { ProviderReleaseRecord } from './daemon-shutdown-report.ts';

const DAEMON_STOP_GRACE_TIMEOUT_MS = 10_000;
const DAEMON_STOP_KILL_TIMEOUT_MS = 2_000;
const DAEMON_STOP_METADATA_WAIT_MS = 1_000;

type DaemonInfo = {
  pid?: unknown;
  processStartTime?: unknown;
};

export type DaemonStopResult = {
  stopped: boolean;
  mode: 'graceful' | 'forced' | 'not-running';
  cleanupConfidence: 'known' | 'unknown';
  claimsReleased: [];
  claimsOrphaned: [];
  providerReleases: {
    status: 'completed' | 'unknown';
    released: ProviderReleaseRecord[];
    pending: ProviderReleaseRecord[] | null;
  };
  warnings: string[];
};

export async function stopDaemon(params: {
  paths: DaemonPaths;
  graceTimeoutMs?: number;
  killTimeoutMs?: number;
}): Promise<DaemonStopResult> {
  const info = readDaemonInfo(params.paths.infoPath);
  if (!info) return notRunningResult();
  if (!isAgentDeviceDaemonProcess(info.pid, info.processStartTime)) {
    if (!isProcessAlive(info.pid)) return notRunningResult();
    throw new AppError(
      'COMMAND_FAILED',
      'Refusing to stop a daemon whose PID or start-time identity could not be verified.',
      { pid: info.pid, processStartTime: info.processStartTime },
    );
  }

  if (!signalDaemonProcess(info.pid, 'SIGTERM')) return notRunningResult();
  const graceful = await waitForProcessExit(
    info.pid,
    params.graceTimeoutMs ?? DAEMON_STOP_GRACE_TIMEOUT_MS,
  );
  if (graceful) {
    await waitForDaemonMetadataRemoval(params.paths, DAEMON_STOP_METADATA_WAIT_MS);
    return {
      stopped: true,
      mode: 'graceful',
      cleanupConfidence: 'known',
      claimsReleased: [],
      claimsOrphaned: [],
      providerReleases: { status: 'completed', released: [], pending: [] },
      warnings: [],
    };
  }

  // Re-verify immediately before escalation so a PID cannot be reused between
  // the graceful wait and SIGKILL.
  if (isAgentDeviceDaemonProcess(info.pid, info.processStartTime)) {
    signalDaemonProcess(info.pid, 'SIGKILL');
  }
  const stopped = await waitForProcessExit(
    info.pid,
    params.killTimeoutMs ?? DAEMON_STOP_KILL_TIMEOUT_MS,
  );
  if (!stopped) {
    throw new AppError('COMMAND_FAILED', 'Daemon did not exit after SIGKILL.', { pid: info.pid });
  }
  return {
    stopped: true,
    mode: 'forced',
    cleanupConfidence: 'unknown',
    claimsReleased: [],
    claimsOrphaned: [],
    providerReleases: { status: 'unknown', released: [], pending: null },
    warnings: [
      'The daemon was force-killed before provider lease state could be finalized. Provider allocations may remain active.',
    ],
  };
}

function signalDaemonProcess(pid: number, signal: NodeJS.Signals): boolean {
  if (trySignalProcess(pid, signal)) return true;
  if (!isProcessAlive(pid)) return false;
  throw new AppError('COMMAND_FAILED', `Daemon could not be signaled with ${signal}.`, {
    pid,
    signal,
  });
}

export function readDaemonStopIdentity(
  infoPath: string,
): { pid: number; processStartTime?: string } | null {
  return readDaemonInfo(infoPath);
}

function readDaemonInfo(infoPath: string): { pid: number; processStartTime?: string } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as DaemonInfo;
    const pid = parsed.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
    return {
      pid,
      ...(typeof parsed.processStartTime === 'string'
        ? { processStartTime: parsed.processStartTime }
        : {}),
    };
  } catch {
    return null;
  }
}

async function waitForDaemonMetadataRemoval(paths: DaemonPaths, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!fs.existsSync(paths.infoPath) && !fs.existsSync(paths.lockPath)) return;
    await sleep(25);
  }
}

function notRunningResult(): DaemonStopResult {
  return {
    stopped: false,
    mode: 'not-running',
    cleanupConfidence: 'known',
    claimsReleased: [],
    claimsOrphaned: [],
    providerReleases: { status: 'completed', released: [], pending: [] },
    warnings: [],
  };
}
