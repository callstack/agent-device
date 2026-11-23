import type { CliFlags } from '@agent-device/contracts/command';
import {
  PLUGIN_INSTALLATION_REASONS,
  REACT_DEVTOOLS_PACKAGE,
  reactDevtoolsInstallCommand,
} from '@agent-device/contracts/plugin-installation';
import { AppError } from '@agent-device/kernel/errors';
import { readVersion } from '@agent-device/host-kit/version';
import { resolveSessionMetroServerUrl } from '@agent-device/react-native';
import type { ReactDevtoolsCommandOptions } from '@agent-device/react-devtools';
import { writeCliOutput } from './shared.ts';

function resolveReactDevtoolsEntry(): string {
  const { package: packageName } = REACT_DEVTOOLS_PACKAGE;
  try {
    return import.meta.resolve(packageName);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND')) {
      throw error;
    }
    const installCommand = reactDevtoolsInstallCommand(readVersion());
    throw new AppError('TOOL_MISSING', `React DevTools requires ${packageName}.`, {
      reason: PLUGIN_INSTALLATION_REASONS.notInstalled,
      package: packageName,
      installCommand,
      hint: `Install alongside agent-device:\n  ${installCommand}`,
    });
  }
}

export async function runReactDevtoolsCommand(
  args: string[],
  options: Omit<ReactDevtoolsCommandOptions, 'resolveMetroServerUrl'> & {
    flags?: Partial<Pick<CliFlags, 'json'>>;
  },
): Promise<number> {
  const { runReactDevtools } = (await import(
    resolveReactDevtoolsEntry()
  )) as typeof import('@agent-device/react-devtools');
  const { stateDir, session } = options;
  const output = await runReactDevtools(args, {
    stateDir,
    session,
    resolveMetroServerUrl: (input) => resolveSessionMetroServerUrl({ stateDir, session }, input),
  });
  await writeCliOutput(options.flags ?? {}, output);
  return 0;
}
