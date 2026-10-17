import {
  readPluginInventory,
  type PluginInventoryEntry,
} from '@agent-device/contracts/plugin-inventory';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import {
  readDaemonStopIdentity,
  stopDaemon,
  type DaemonStopResult,
} from '@agent-device/daemon-contracts/daemon-stop';
import {
  isUnusableRecord,
  readDaemonStatus,
  type DaemonStatus,
} from '@agent-device/daemon-contracts/daemon-registration';
import { readDaemonShutdownReport } from '@agent-device/daemon-contracts/daemon-shutdown-report';
import { AppError } from '@agent-device/kernel/errors';
import { writeCommandOutput } from './shared.ts';
import type { ClientCommandHandler } from './router-types.ts';
import { createDaemonOwnerCleanup } from '../../platform-runtime-daemon-owner-cleanup.ts';

const daemonOwnerCleanup = createDaemonOwnerCleanup();

export const daemonCommand: ClientCommandHandler = async ({ positionals, flags, host }) => {
  const subcommand = positionals[0];
  if ((subcommand !== 'stop' && subcommand !== 'status') || positionals.length !== 1) {
    throw new AppError('INVALID_ARGS', 'daemon accepts only: stop, status');
  }
  const paths = resolveDaemonPaths(flags.stateDir, {
    cwd: host.cwd,
    env: host.env,
  });
  if (subcommand === 'status') {
    const status = readDaemonStatus(paths);
    const shown = { ...status, plugins: readPluginInventory(status.plugins) };
    await writeCommandOutput(flags, shown, () => renderDaemonStatus(shown));
    return true;
  }
  const identity = readDaemonStopIdentity(paths.infoPath);
  const stopped = await stopDaemon({ paths });
  const report = stopped.mode === 'graceful' ? readDaemonShutdownReport(paths.baseDir) : null;
  const result = mergeShutdownReport(stopped, report);
  const shouldClean = flags.clean === true && identity !== null && result.stopped;
  if (shouldClean) {
    await daemonOwnerCleanup.cleanup({
      pid: identity.pid,
      startTime: identity.processStartTime,
    });
  }
  const data = { ...result, clean: shouldClean };
  await writeCommandOutput(flags, data, () => renderDaemonStop(data));
  return true;
};

function mergeShutdownReport(
  stopped: DaemonStopResult,
  report: ReturnType<typeof readDaemonShutdownReport>,
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

function renderDaemonStop(
  result: Pick<DaemonStopResult, 'stopped' | 'mode' | 'warnings'> & {
    clean: boolean;
  },
): string {
  const headline = result.stopped ? `Daemon stopped (${result.mode}).` : 'No running daemon found.';
  return [headline, result.clean ? 'Retained runner cleanup completed.' : null, ...result.warnings]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

function renderDaemonStatus(
  status: Omit<DaemonStatus, 'plugins'> & { plugins: readonly PluginInventoryEntry[] },
): string {
  if (isUnusableRecord(status)) {
    return `The daemon record for ${status.stateDir} is ${status.state === 'invalid' ? 'not a valid record' : 'unreadable'}, so whether a daemon runs there is unknown.`;
  }
  if (status.state === 'stopped') return `No running daemon for ${status.stateDir}.`;
  const details = [`pid ${status.pid}`, status.version, status.transport].filter(Boolean);
  return [
    `Daemon running (${details.join(', ')}) for ${status.stateDir}.`,
    ...(status.plugins.length === 0
      ? ['No providers registered.']
      : [
          'Providers:',
          ...status.plugins.map((plugin) => {
            const origin = plugin.package
              ? `${plugin.package}${plugin.version ? `@${plugin.version}` : ''}`
              : plugin.source;
            const outcome =
              plugin.state === 'active'
                ? 'active'
                : `failed: ${plugin.error?.message ?? 'unknown'}`;
            return `  ${plugin.provider ?? '(unknown provider)'} [${plugin.source}] ${origin} - ${outcome}`;
          }),
        ]),
  ].join('\n');
}
