import { AppError } from '@agent-device/kernel/errors';
import { changePlugin, listPlugins } from '../../plugins/store.ts';
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
    await changePlugin(action as 'add' | 'update' | 'remove', name, process.env);
  }
  const plugins = listPlugins(process.env);
  await writeCommandOutput(flags, { plugins, restartRequired: action !== 'list' }, () =>
    [
      ...plugins.map((plugin) =>
        plugin.compatible
          ? `${plugin.name}@${plugin.version} (${plugin.provider})`
          : `${plugin.name}: unavailable; run plugins update ${plugin.name} or plugins remove ${plugin.name}`,
      ),
      ...(action !== 'list'
        ? ['Restart the local daemon after closing active sessions to use the changed plugin set.']
        : []),
      ...(plugins.length === 0 ? ['No provider plugins installed.'] : []),
    ].join('\n'),
  );
  return true;
};
