import { AppError } from '@agent-device/kernel/errors';
import type { DaemonRetirementResult } from './daemon-registration-owner.ts';

import {
  DAEMON_LIFECYCLE_REASONS,
  DAEMON_RECORD_OWNER_UNRECOGNIZED_REASON,
  type DaemonPaths,
  type ObservedDaemonIdentity,
} from './daemon-resolution.ts';
import type { OwnerIdentity } from '@agent-device/host-kit/process';
import type {
  DaemonShutdownReport,
  DeviceClaimRecord,
  ProviderReleaseRecord,
} from './daemon-shutdown-report.ts';

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

/**
 * Retires the daemon whose lifetime the caller read, and shapes that retirement as a stop result.
 *
 * The caller hands over the lifetime and the owner its own read proved, so routing and retirement judge
 * one record. Ownership is judged here and nowhere else: an embedded runtime belongs to its host, and a
 * record this build cannot place proves nothing about what is safe to signal, so both come back as the
 * refusal that names their owner, with nothing signaled.
 */
export async function stopDaemon(params: {
  paths: DaemonPaths;
  observed: ObservedDaemonIdentity | null;
  graceTimeoutMs?: number;
  killTimeoutMs?: number;
}): Promise<DaemonStopResult> {
  const observed = params.observed;
  if (!observed) return daemonNotRunningStopResult();
  const { stopAndRetireDaemon } = await import('./daemon-registration-owner.ts');
  const retirement = await stopAndRetireDaemon({
    paths: params.paths,
    observed,
    mode: 'graceful',
    termTimeoutMs: params.graceTimeoutMs ?? DAEMON_STOP_GRACE_TIMEOUT_MS,
    killTimeoutMs: params.killTimeoutMs ?? DAEMON_STOP_KILL_TIMEOUT_MS,
  });
  if (retirement.status === 'retained' && retirement.termination?.status === 'not-running')
    return daemonNotRunningStopResult();
  if (retirement.status !== 'retired') throw daemonRetirementError(observed, retirement);
  if (retirement.termination.mode === 'already-exited') return daemonNotRunningStopResult();
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

/**
 * What a retirement that refused because of the record's owner answers with. This is the one place
 * those two retained reasons become a stop's own reason: a caller that may not signal this process
 * hears the owner's rule, not a retirement that could not be confirmed.
 */
function ownerRefusal(
  reason: 'embedded-owner' | 'owner-unproven',
): Readonly<{ reason: string; hint: string }> {
  return reason === 'embedded-owner'
    ? {
        reason: DAEMON_LIFECYCLE_REASONS.ownerEmbedded,
        hint: 'Nothing was signaled. Close the host that started this runtime, or repair its record after the process has exited.',
      }
    : {
        reason: DAEMON_RECORD_OWNER_UNRECOGNIZED_REASON,
        hint: 'Nothing was signaled. Check what owns that process, then repair the record: stop it by its own means and remove its daemon.json so a daemon can register again.',
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
  const refusal =
    retirement.status === 'retained' &&
    (retirement.reason === 'embedded-owner' || retirement.reason === 'owner-unproven')
      ? ownerRefusal(retirement.reason)
      : undefined;
  return new AppError(
    'COMMAND_FAILED',
    refusal
      ? 'The daemon was not stopped, because its owner ends it.'
      : 'Daemon retirement could not be confirmed.',
    {
      pid: info.pid,
      processStartTime: info.startTime,
      reason:
        refusal?.reason ?? (failure ? 'daemon_exit_unconfirmed' : 'daemon_retirement_unconfirmed'),
      terminationReason: failure?.reason,
      signal: failure?.signal,
      retirement,
      hint: hint ?? refusal?.hint,
      diagnosticId,
      logPath,
    },
  );
}

function daemonNotRunningStopResult(): DaemonStopResult {
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

export function mergeDaemonShutdownReport(
  stopped: DaemonStopResult,
  report: DaemonShutdownReport | null,
): DaemonStopResult {
  if (stopped.mode !== 'graceful' || report) {
    return report
      ? {
          ...stopped,
          providerReleases: { status: 'completed', ...report.providerReleases },
          claimsReleased: report.claims.released,
          claimsOrphaned: report.claims.orphaned,
          claimsSuperseded: report.claims.superseded,
          claimsUnattributable: report.claims.unattributable,
          warnings: [
            ...stopped.warnings,
            ...supersededClaimWarnings(report.claims.superseded),
            ...orphanedClaimWarnings(report.claims.orphaned),
            ...unattributableClaimWarnings(report.claims.unattributable),
          ],
        }
      : stopped;
  }
  return {
    ...stopped,
    cleanupConfidence: 'unknown',
    providerReleases: { status: 'unknown', released: [], pending: null },
    warnings: [
      ...stopped.warnings,
      'The graceful shutdown report is unavailable, so provider cleanup state is unknown. Provider allocations may remain active.',
    ],
  };
}

/** A superseded claim is not a failure to report as one, but the operator's
 * device is now owned elsewhere, so it must not pass silently. */
function supersededClaimWarnings(superseded: DaemonStopResult['claimsSuperseded']): string[] {
  if (superseded.length === 0) return [];
  const devices = superseded.map((claim) => claim.deviceId).join(', ');
  return [
    `Another owner had already claimed ${devices} before this daemon released it, so those devices are now owned elsewhere.`,
  ];
}

/** An orphaned claim keeps holding its device after the daemon is gone, and
 * only `device release --stale` or the next open settles it — say so instead
 * of leaving the block discoverable through --json alone.
 *
 * A record whose owner could not be attributed is NOT reported here. Those are what
 * `--stale` hides and refuses, so this sentence would send the operator to a route that cannot
 * succeed; {@link unattributableClaimWarnings} names the view that does show them. */
function orphanedClaimWarnings(orphaned: DaemonStopResult['claimsOrphaned']): string[] {
  if (orphaned.length === 0) return [];
  const devices = orphaned.map((claim) => claim.deviceId).join(', ');
  return [
    `Ownership of ${devices} was not released cleanly; the claim now blocks other owners until it is settled. Inspect with: agent-device device status --stale, then release with: agent-device device release --stale.`,
  ];
}

/**
 * What the three provable buckets each get an exact remedy for, this one does not: settling a claim
 * always rests on a proof about its owner, and this record names none. So the warning states only
 * what is known, points at the view that lists these records — the default one, because `--stale`
 * filters records without a decodable owner out — and does not promise a release that would clear
 * them. `device release --stale` refuses every record that names no owner, and the next `open` refuses
 * to overwrite one.
 */
function unattributableClaimWarnings(
  unattributable: DaemonStopResult['claimsUnattributable'],
): string[] {
  if (unattributable.length === 0) return [];
  const devices = unattributable.map((claim) => claim.deviceId).join(', ');
  return [
    `A claim for ${devices} remains whose owner could not be read, so this daemon cannot say whether those devices are free. ` +
      'No device release route settles it: --stale proves staleness from the recorded owner and refuses records that name none, ' +
      'and open refuses to overwrite them. Inspect with: agent-device device status.',
  ];
}
