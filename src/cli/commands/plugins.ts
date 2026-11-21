import path from 'node:path';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { readPluginInventory } from '@agent-device/contracts/plugin-inventory';
import {
  isUnusableRecord,
  readDaemonStatus,
} from '@agent-device/daemon-contracts/daemon-registration';
import { AppError } from '@agent-device/kernel/errors';
import { addPluginArtifact, changePlugin, listPlugins } from '@agent-device/plugins/store';
import { writeCommandOutput } from './shared.ts';
import type { ClientCommandHandler } from './router-types.ts';

export const pluginsCommand: ClientCommandHandler = async ({ host, positionals, flags }) => {
  const [action = 'list', name, extra] = positionals;
  if (
    extra ||
    !['add', 'update', 'remove', 'list'].includes(action) ||
    (action === 'list' ? name !== undefined : !name)
  ) {
    throw new AppError(
      'INVALID_ARGS',
      'Use plugins list, add <package[@version]|path.tgz>, update <package>, or remove <package>',
    );
  }
  const artifact =
    action === 'add' && name && (path.isAbsolute(name) || /^\.{1,2}[\\/]/.test(name))
      ? await addPluginArtifact(name, host)
      : undefined;
  if (action !== 'list' && !artifact && name) {
    await changePlugin(action as 'add' | 'update' | 'remove', name, host.env);
  }
  const plugins = artifact ? [] : await listPlugins(host.env, []);
  const daemon = readDaemonStatus(resolveDaemonPaths(flags.stateDir, host));
  const daemonPlugins = readPluginInventory(daemon.plugins);
  const failedInDaemon = daemonPlugins.filter(({ state }) => state === 'failed');
  const data = {
    ...(artifact ? { artifact: { ...artifact, compatibility: 'unchecked' } } : { plugins }),
    ...(daemon.state === 'running'
      ? { daemon: { pid: daemon.pid, stateDir: daemon.stateDir, plugins: daemonPlugins } }
      : {}),
    ...(isUnusableRecord(daemon) ? { daemonRecord: daemon.state } : {}),
    restartRequired: action !== 'list',
  };
  await writeCommandOutput(flags, data, () =>
    [
      ...(artifact
        ? [
            `${artifact.name}@${artifact.version}: installed; compatibility unchecked. Run agent-device plugins list.`,
          ]
        : plugins.map((plugin) =>
            plugin.compatible
              ? `${plugin.name}@${plugin.version} (${plugin.provider ?? plugin.platform ?? plugin.backend})`
              : plugin.name === undefined
                ? `Plugin config unavailable: ${plugin.error?.message}`
                : `${plugin.name}: unavailable; run plugins update ${plugin.name} or plugins remove ${plugin.name}`,
          )),
      ...(action !== 'list'
        ? ['Restart the local daemon after closing active sessions to use the changed plugin set.']
        : []),
      ...(!artifact && plugins.length === 0 ? ['No provider plugins installed.'] : []),
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
