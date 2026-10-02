import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import { stopDaemonProcess } from '../daemon-process.ts';
import { sleep } from '@agent-device/host-kit/retry';

import type { DaemonPaths } from '../daemon-resolution.ts';
import { readRegisteredDaemonIdentity } from '../daemon-registration.ts';
import type { DeviceClaimRecord, ProviderReleaseRecord } from '../daemon-shutdown-report.ts';

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
  /**
   * Claims whose on-disk record named no owner, so this daemon cannot say whether the device is
   * still held. `device release --stale` cannot settle these — it proves staleness from a recorded
   * owner — so they are reported apart from {@link DaemonStopResult.claimsOrphaned}.
   */
  claimsUnattributable: DeviceClaimRecord[];
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
  const termination = await stopDaemonProcess(info, {
    mode: 'graceful',
    termTimeoutMs: params.graceTimeoutMs ?? DAEMON_STOP_GRACE_TIMEOUT_MS,
    killTimeoutMs: params.killTimeoutMs ?? DAEMON_STOP_KILL_TIMEOUT_MS,
  });
  if (termination.status === 'retained') {
    throw new AppError('COMMAND_FAILED', 'Daemon termination could not be confirmed.', {
      pid: info.pid,
      processStartTime: info.startTime,
      reason: 'daemon_exit_unconfirmed',
      terminationReason: termination.reason,
      signal: termination.signal,
    });
  }
  if (termination.status === 'not-running' || termination.mode === 'already-exited') {
    return notRunningResult();
  }
  if (termination.mode === 'graceful') {
    await waitForDaemonMetadataRemoval(params.paths, DAEMON_STOP_METADATA_WAIT_MS);
    return {
      stopped: true,
      mode: 'graceful',
      cleanupConfidence: 'known',
      claimsReleased: [],
      claimsOrphaned: [],
      claimsSuperseded: [],
      claimsUnattributable: [],
      providerReleases: { status: 'completed', released: [], pending: [] },
      warnings: [],
    };
  }

  return {
    stopped: true,
    mode: 'forced',
    cleanupConfidence: 'unknown',
    claimsReleased: [],
    claimsOrphaned: [],
    claimsSuperseded: [],
    claimsUnattributable: [],
    providerReleases: { status: 'unknown', released: [], pending: null },
    warnings: [
      'The daemon was force-killed before provider lease state could be finalized. Provider allocations may remain active.',
    ],
  };
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
    claimsUnattributable: [],
    providerReleases: { status: 'completed', released: [], pending: [] },
    warnings: [],
  };
}
