import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import {
  isAgentDeviceDaemonProcess,
  trySignalProcess,
  waitForDaemonExit,
  type DaemonProcessIdentity,
} from './daemon-process.ts';
import { isProcessAlive } from '../utils/host-process.ts';
import { sleep } from '../utils/timeouts.ts';
import type { DaemonPaths } from './config.ts';
import { readRegisteredDaemonIdentity } from './daemon-registration.ts';
import type { DeviceClaimRecord, ProviderReleaseRecord } from './daemon-shutdown-report.ts';

const DAEMON_STOP_GRACE_TIMEOUT_MS = 10_000;
const DAEMON_STOP_KILL_TIMEOUT_MS = 2_000;
const DAEMON_STOP_METADATA_WAIT_MS = 1_000;

export type DaemonStopResult = {
  stopped: boolean;
  mode: 'graceful' | 'forced' | 'not-running';
  cleanupConfidence: 'known' | 'unknown';
  /**
   * #1320 claim results. Only a graceful stop can carry values: they come from
   * the shutdown report the exiting daemon wrote, so a forced kill or a daemon
   * that was not running reports none rather than claiming certainty.
   */
  claimsReleased: DeviceClaimRecord[];
  claimsOrphaned: DeviceClaimRecord[];
  /** Claims another owner had already taken over; this daemon released nothing. */
  claimsSuperseded: DeviceClaimRecord[];
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
  const info = readRegisteredDaemonIdentity(params.paths.infoPath);
  if (!info) return notRunningResult();
  if (!info.startTime) {
    if (!isProcessAlive(info.pid)) return notRunningResult();
    throw new AppError(
      'COMMAND_FAILED',
      'Refusing to stop a daemon without a verified process start-time identity.',
      { pid: info.pid },
    );
  }
  if (!isAgentDeviceDaemonProcess(info.pid, info.startTime)) {
    if (!isProcessAlive(info.pid)) return notRunningResult();
    throw new AppError(
      'COMMAND_FAILED',
      'Refusing to stop a daemon whose PID or start-time identity could not be verified.',
      { pid: info.pid, processStartTime: info.startTime },
    );
  }

  const identity: DaemonProcessIdentity = { pid: info.pid, startTime: info.startTime };
  if (!signalDaemonProcess(info.pid, 'SIGTERM')) return notRunningResult();
  const { exited: graceful } = await waitForDaemonExit(identity, {
    timeoutMs: params.graceTimeoutMs ?? DAEMON_STOP_GRACE_TIMEOUT_MS,
  });
  if (graceful) {
    await waitForDaemonMetadataRemoval(params.paths, DAEMON_STOP_METADATA_WAIT_MS);
    return {
      stopped: true,
      mode: 'graceful',
      cleanupConfidence: 'known',
      claimsReleased: [],
      claimsOrphaned: [],
      claimsSuperseded: [],
      providerReleases: { status: 'completed', released: [], pending: [] },
      warnings: [],
    };
  }

  // Re-verify immediately before escalation so a PID cannot be reused between
  // the graceful wait and SIGKILL.
  if (isAgentDeviceDaemonProcess(info.pid, info.startTime)) {
    signalDaemonProcess(info.pid, 'SIGKILL');
  }
  const { exited: stopped } = await waitForDaemonExit(identity, {
    timeoutMs: params.killTimeoutMs ?? DAEMON_STOP_KILL_TIMEOUT_MS,
  });
  if (!stopped) {
    throw new AppError('COMMAND_FAILED', 'Daemon did not exit after SIGKILL.', { pid: info.pid });
  }
  return {
    stopped: true,
    mode: 'forced',
    cleanupConfidence: 'unknown',
    claimsReleased: [],
    claimsOrphaned: [],
    claimsSuperseded: [],
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
): { pid: number; processStartTime: string } | null {
  const info = readRegisteredDaemonIdentity(infoPath);
  if (!info?.startTime) return null;
  return { pid: info.pid, processStartTime: info.startTime };
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
    claimsSuperseded: [],
    providerReleases: { status: 'completed', released: [], pending: [] },
    warnings: [],
  };
}
