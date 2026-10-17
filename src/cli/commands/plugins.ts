import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { readPluginInventory } from '@agent-device/contracts/plugin-inventory';
import {
  isUnusableRecord,
  readDaemonStatus,
} from '@agent-device/daemon-contracts/daemon-registration';
import { AppError } from '@agent-device/kernel/errors';
import { changePlugin, listPlugins } from '@agent-device/plugins/store';
import { BUILTIN_PROVIDER_IDS } from '../../builtin-provider-ids.ts';
import { writeCommandOutput } from './shared.ts';
import type { ClientCommandHandler } from './router-types.ts';

export const pluginsCommand: ClientCommandHandler = async ({ positionals, flags }) => {
  const [action = 'list', name, extra] = positionals;
  if (
    extra ||
    !['add', 'update', 'remove', 'list'].includes(action) ||
    (action === 'list' ? name !== undefined : !name)
  ) {
    throw new AppError(
      'INVALID_ARGS',
      'Use plugins list, add <package[@version]>, update <package>, or remove <package>',
    );
  }
  if (action !== 'list' && name) {
    await changePlugin(
      action as 'add' | 'update' | 'remove',
      name,
      process.env,
      BUILTIN_PROVIDER_IDS,
    );
  }
  const plugins = await listPlugins(process.env, BUILTIN_PROVIDER_IDS);
  const daemon = readDaemonStatus(resolveDaemonPaths(flags.stateDir));
  const daemonPlugins = readPluginInventory(daemon.plugins);
  const failedInDaemon = daemonPlugins.filter(({ state }) => state === 'failed');
  const data = {
    plugins,
    ...(daemon.state === 'running'
      ? { daemon: { pid: daemon.pid, stateDir: daemon.stateDir, plugins: daemonPlugins } }
      : {}),
    ...(isUnusableRecord(daemon) ? { daemonRecord: daemon.state } : {}),
    restartRequired: action !== 'list',
  };
  await writeCommandOutput(flags, data, () =>
    [
      ...plugins.map((plugin) =>
        plugin.compatible
          ? `${plugin.name}@${plugin.version} (${plugin.provider})`
          : plugin.name === undefined
            ? `Plugin config unavailable: ${plugin.error?.message}`
            : `${plugin.name}: unavailable; run plugins update ${plugin.name} or plugins remove ${plugin.name}`,
      ),
      ...(action !== 'list'
        ? ['Restart the local daemon after closing active sessions to use the changed plugin set.']
        : []),
      ...(plugins.length === 0 ? ['No provider plugins installed.'] : []),
      ...(isUnusableRecord(daemon)
        ? [
            `The daemon record for ${daemon.stateDir} is ${daemon.state}, so its providers are unknown.`,
          ]
        : []),
      ...failedInDaemon.map(
        (plugin) =>
          `The running daemon did not register ${plugin.package ?? plugin.provider ?? plugin.source}: ${plugin.error?.message}`,
      ),
    ].join('\n'),
  );
  return true;
};
