import type { CliFlags } from '@agent-device/contracts/command';
import { writeCliOutput } from './shared.ts';
import { AppError } from '@agent-device/kernel/errors';
import type { ReactDevtoolsCommandOptions } from '../react-devtools/react-devtools-connection.ts';
import {
  isInspectCommand,
  runReactInspectCommand,
} from '../react-devtools/react-devtools-inspect-command.ts';
import { runReactProfileCommand } from '../react-devtools/react-profile-command.ts';

export async function runReactDevtoolsCommand(
  args: string[],
  options: ReactDevtoolsCommandOptions & { flags?: Partial<Pick<CliFlags, 'json'>> },
): Promise<number> {
  const [command, ...rest] = args;
  const output =
    command === 'profile'
      ? await runReactProfileCommand(rest, options)
      : isInspectCommand(command)
        ? await runReactInspectCommand(command, rest, options)
        : undefined;
  if (!output)
    throw new AppError('INVALID_ARGS', `Unknown react-devtools command: ${command ?? '(none)'}.`, {
      hint: 'Use react-devtools tree, find, inspect, errors, or profile.',
    });
  await writeCliOutput(options.flags ?? {}, output);
  return 0;
}
