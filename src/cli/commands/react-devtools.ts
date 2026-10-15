import { AppError } from '@agent-device/kernel/errors';
import type { ReactDevtoolsCommandOptions } from '../react-devtools/react-devtools-connection.ts';
import {
  isInspectCommand,
  runReactInspectCommand,
} from '../react-devtools/react-devtools-inspect-command.ts';
import { runReactProfileCommand } from '../react-devtools/react-profile-command.ts';

export async function runReactDevtoolsCommand(
  args: string[],
  options: ReactDevtoolsCommandOptions,
): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'profile') return await runReactProfileCommand(rest, options);
  if (isInspectCommand(command)) return await runReactInspectCommand(command, rest, options);
  throw new AppError('INVALID_ARGS', `Unknown react-devtools command: ${command ?? '(none)'}.`, {
    hint: 'Use react-devtools tree, find, inspect, errors, or profile.',
  });
}
