import { resolveDaemonPaths } from '../../daemon/config.ts';
import {
  readDaemonStopIdentity,
  stopDaemon,
  type DaemonStopResult,
} from '../../daemon/daemon-stop.ts';
import { readDaemonShutdownReport } from '../../daemon/daemon-shutdown-report.ts';
import { AppError } from '../../kernel/errors.ts';
import { writeCommandOutput } from './shared.ts';
import type { ClientCommandHandler } from './router-types.ts';

export const daemonCommand: ClientCommandHandler = async ({ positionals, flags }) => {
  const subcommand = positionals[0];
  if (subcommand !== 'stop' || positionals.length !== 1) {
    throw new AppError('INVALID_ARGS', 'daemon accepts only: stop');
  }
  const paths = resolveDaemonPaths(flags.stateDir);
  const identity = readDaemonStopIdentity(paths.infoPath);
  const stopped = await stopDaemon({ paths });
  const report = stopped.mode === 'graceful' ? readDaemonShutdownReport(paths.baseDir) : null;
  const result = mergeShutdownReport(stopped, report);
  const shouldClean = flags.clean === true && identity !== null && result.stopped;
  if (shouldClean) {
    const [{ cleanupRunnerLeasesForOwner }, { runnerLeaseCleanupAdapter }] = await Promise.all([
      import('../../platforms/apple/core/runner/runner-lease.ts'),
      import('../../platforms/apple/core/runner/runner-disposal.ts'),
    ]);
    await cleanupRunnerLeasesForOwner(
      { pid: identity.pid, startTime: identity.processStartTime },
      runnerLeaseCleanupAdapter,
    );
  }
  const data = { ...result, clean: shouldClean };
  writeCommandOutput(flags, data, () => renderDaemonStop(data));
  return true;
};

function mergeShutdownReport(
  stopped: DaemonStopResult,
  report: ReturnType<typeof readDaemonShutdownReport>,
): DaemonStopResult {
  if (stopped.mode !== 'graceful' || report) {
    return report
      ? { ...stopped, providerReleases: { status: 'completed', ...report.providerReleases } }
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
