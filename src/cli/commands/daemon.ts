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
import { ownerRefusal, type DaemonStopResult } from '@agent-device/daemon-contracts/daemon-stop';
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
  // Cleanup may walk only a detached daemon's process tree; a host may own unrelated work.
  if (flags.clean === true && record.ownership !== 'absent' && record.ownership !== 'detached') {
    throw daemonCleanRefusedForUnprovenOwner(paths, record);
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

/** Refuses process-tree cleanup unless the record proves detached ownership. */
function daemonCleanRefusedForUnprovenOwner(
  paths: DaemonPaths,
  record: DaemonStopIdentity,
): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'This daemon record does not prove the process is a daemon of its own, so its retained-runner cleanup cannot be run from here.',
    {
      reason: 'daemon-clean-not-detached',
      stateDir: paths.baseDir,
      ownership: record.ownership,
      hint: daemonCleanRefusalHint(paths, record),
    },
  );
}

/**
 * Directs host-owned and unrecognized records to their owner's remedy. Only a registration whose
 * host has provably exited can be retired by a plain stop. Unreadable records need repair first.
 */
function daemonCleanRefusalHint(paths: DaemonPaths, record: DaemonStopIdentity): string {
  if (record.ownership === 'unreadable') {
    return `Nothing was signaled. Check what owns that process, then repair the record: stop it by its own means and remove ${shellQuoteIfNeeded(`${paths.baseDir}/daemon.json`)} so a daemon can register again.`;
  }
  return ownerRefusal(
    record.ownership === 'embedded' ? 'embedded-owner' : 'owner-unproven',
    record.identity?.pid,
  ).hint;
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
