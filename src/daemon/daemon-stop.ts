import { AppError } from '@agent-device/kernel/errors';
import type { DaemonRetirementResult } from '../daemon-registration-owner.ts';
import type { OwnerIdentity } from '@agent-device/host-kit/process';

import type { DaemonPaths } from '../daemon-resolution.ts';
import { readRegisteredDaemonIdentity } from '../daemon-registration.ts';
import type { DeviceClaimRecord, ProviderReleaseRecord } from '../daemon-shutdown-report.ts';

const DAEMON_STOP_GRACE_TIMEOUT_MS = 10_000;
const DAEMON_STOP_KILL_TIMEOUT_MS = 2_000;

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
  const { stopAndRetireDaemon } = await import('../daemon-registration-owner.ts');
  const retirement = await stopAndRetireDaemon({
    paths: params.paths,
    observed: info,
    mode: 'graceful',
    termTimeoutMs: params.graceTimeoutMs ?? DAEMON_STOP_GRACE_TIMEOUT_MS,
    killTimeoutMs: params.killTimeoutMs ?? DAEMON_STOP_KILL_TIMEOUT_MS,
  });
  if (retirement.status === 'retained' && retirement.termination?.status === 'not-running')
    return notRunningResult();
  if (retirement.status !== 'retired') throw daemonRetirementError(info, retirement);
  if (retirement.termination.mode === 'already-exited') return notRunningResult();
  if (retirement.termination.mode === 'graceful') {
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

function daemonRetirementError(
  info: OwnerIdentity,
  retirement: Exclude<DaemonRetirementResult, { status: 'retired' }>,
): AppError {
  const termination = retirement.status === 'retained' ? retirement.termination : undefined;
  const failure = termination?.status === 'retained' ? termination : undefined;
  const error = retirement.status === 'retained' ? retirement.error : undefined;
  const { hint, diagnosticId, logPath } = error ?? {};
  return new AppError('COMMAND_FAILED', 'Daemon retirement could not be confirmed.', {
    pid: info.pid,
    processStartTime: info.startTime,
    reason: failure ? 'daemon_exit_unconfirmed' : 'daemon_retirement_unconfirmed',
    terminationReason: failure?.reason,
    signal: failure?.signal,
    retirement,
    hint,
    diagnosticId,
    logPath,
  });
}

export function readDaemonStopIdentity(
  infoPath: string,
): { pid: number; processStartTime: string } | null {
  const info = readRegisteredDaemonIdentity(infoPath);
  if (!info?.startTime) return null;
  return { pid: info.pid, processStartTime: info.startTime };
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
