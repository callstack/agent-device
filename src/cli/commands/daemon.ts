import { resolveDaemonPaths } from '../../daemon/config.ts';
import { readDaemonStopIdentity, stopDaemon } from '../../daemon/daemon-stop.ts';
import { readDaemonShutdownReport } from '../../daemon/daemon-shutdown-report.ts';
import { AppError } from '../../kernel/errors.ts';
import { cleanupRunnerLeasesForOwner } from '../../platforms/apple/core/runner/runner-lease.ts';
import { runnerLeaseCleanupAdapter } from '../../platforms/apple/core/runner/runner-disposal.ts';
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
  const result = report
    ? { ...stopped, providerReleases: { status: 'completed' as const, ...report.providerReleases } }
    : stopped;
  if (flags.clean === true && identity !== null && result.stopped) {
    await cleanupRunnerLeasesForOwner(identity, runnerLeaseCleanupAdapter);
  }
  const cleaned = flags.clean === true && identity !== null && result.stopped;
  const data = { ...result, clean: cleaned };
  writeCommandOutput(flags, data, () => renderDaemonStop(data));
  return true;
};

function renderDaemonStop(result: {
  stopped: boolean;
  mode: string;
  clean: boolean;
  warnings: readonly string[];
}): string {
  const headline = result.stopped ? `Daemon stopped (${result.mode}).` : 'No running daemon found.';
  return [headline, result.clean ? 'Retained runner cleanup completed.' : null, ...result.warnings]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}
