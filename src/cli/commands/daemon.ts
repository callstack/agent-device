import {
  readPluginInventory,
  type PluginInventoryEntry,
} from '@agent-device/contracts/plugin-inventory';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import type { DaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import {
  isUnusableRecord,
  readDaemonStatus,
  readDaemonStopIdentity,
  readStopCleanupOwner,
  type DaemonStatus,
  type DaemonStopIdentity,
} from '@agent-device/daemon-contracts/daemon-registration';
import type { DaemonStopResult } from '@agent-device/daemon-contracts/daemon-stop';
import { AppError } from '@agent-device/kernel/errors';
import { shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';
import { writeCommandOutput } from './shared.ts';
import type { ClientCommandHandler } from './router-types.ts';
import { createDaemonOwnerCleanup } from '../../platform-runtime-daemon-owner-cleanup.ts';
import { stopRecordedDaemon } from '../../daemon-client/daemon-client-stop.ts';

export const daemonCommand: ClientCommandHandler = async ({ positionals, flags, host }) => {
  const daemonOwnerCleanup = createDaemonOwnerCleanup(host);
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
  // One read decides every route below, so routing, retirement, and a `--clean` walk judge the same
  // record rather than three snapshots of a file another process may be rewriting.
  const record = readDaemonStopIdentity(paths.infoPath);
  // Retained-runner cleanup works across the owner's whole process tree, which a host process shares
  // with whatever else it runs. An embedded runtime's own close is the boundary a stop may cross, and
  // a record that cannot prove its owner is not a licence to walk a process tree either. No record at all
  // is not a refusal: there is nothing claimed, so there is nothing to clean.
  if (flags.clean === true && record.ownership !== 'absent' && record.ownership !== 'detached') {
    throw daemonCleanRefusedForUnprovenOwner(paths, record.ownership);
  }
  const result = await stopRecordedDaemon(record, { paths, host });
  const cleanupOwner = readStopCleanupOwner(record);
  const shouldClean = flags.clean === true && cleanupOwner !== null && result.stopped;
  if (shouldClean) {
    await daemonOwnerCleanup.cleanup({
      pid: cleanupOwner.pid,
      startTime: cleanupOwner.processStartTime,
    });
  }
  const data = { ...result, clean: shouldClean };
  await writeCommandOutput(flags, data, () => renderDaemonStop(data));
  return true;
};

/**
 * `--clean` walks the owner's whole process tree, which for a host process includes everything else
 * that host runs. An embedded runtime's own close is the only boundary a stop may cross, so this
 * refuses instead of reaching past it, and the stop without `--clean` still works.
 *
 * A record whose owner cannot be read is refused too: the tree this would walk may be a host's, and
 * the reason cleanup is allowed for a detached daemon is that its record proves the process is a
 * daemon of its own. This is not a bad flag — the flag is fine, the record is the problem — so it
 * reports as a failed command, like the other ownership refusals.
 */
function daemonCleanRefusedForUnprovenOwner(
  paths: DaemonPaths,
  record: DaemonStopIdentity['ownership'],
): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'This daemon record does not prove the process is a daemon of its own, so its retained-runner cleanup cannot be run from here.',
    {
      reason: 'daemon-clean-not-detached',
      stateDir: paths.baseDir,
      ownership: record,
      hint: daemonCleanRefusalHint(paths, record),
    },
  );
}

/**
 * What to do next, which depends on whether a plain `daemon stop` has a route left for this record.
 * A readable record naming a host or an unfamiliar owner does: that stop asks the running process to
 * leave and never signals it. A record that cannot be read has none — the same stop refuses it for the
 * same reason — so its hint names the record repair instead of sending the operator to a second refusal.
 */
function daemonCleanRefusalHint(
  paths: DaemonPaths,
  record: DaemonStopIdentity['ownership'],
): string {
  if (record === 'unreadable') {
    return `Nothing was signaled. Check what owns that process, then repair the record: stop it by its own means and remove ${shellQuoteIfNeeded(`${paths.baseDir}/daemon.json`)} so a daemon can register again.`;
  }
  if (record === 'embedded') {
    return 'Stop it without --clean, which drains it through its own close, or let the host that started it close it.';
  }
  return 'Stop it without --clean, which asks the running process to leave and reports what it answers.';
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
  const details = [
    `pid ${status.pid}`,
    // An embedded pid belongs to a host process, and an unrecognized owner says the record states an
    // owner this build cannot read; either way, what a stop may do to that pid changes.
    status.ownership === 'embedded'
      ? 'host-owned'
      : status.ownership === 'unknown'
        ? 'owner-not-recognized'
        : null,
    status.version,
    status.transport,
  ].filter(Boolean);
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
