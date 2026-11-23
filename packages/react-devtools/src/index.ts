import { AppError } from '@agent-device/kernel/errors';
import type { ReactDevtoolsCommandOptions } from './react-devtools/react-devtools-connection.ts';
import type { ReactDevtoolsOutput } from './react-devtools/react-devtools-output.ts';

export type { ReactDevtoolsCommandOptions };

export async function runReactDevtools(
  args: string[],
  options: ReactDevtoolsCommandOptions,
): Promise<ReactDevtoolsOutput> {
  const [command, ...rest] = args;
  let output: ReactDevtoolsOutput | undefined;
  if (command === 'profile') {
    const { runReactProfileCommand } = await import('./react-devtools/react-profile-command.ts');
    output = await runReactProfileCommand(rest, options);
  } else {
    const { isInspectCommand, runReactInspectCommand } =
      await import('./react-devtools/react-devtools-inspect-command.ts');
    if (isInspectCommand(command)) output = await runReactInspectCommand(command, rest, options);
  }
  if (!output)
    throw new AppError('INVALID_ARGS', `Unknown react-devtools command: ${command ?? '(none)'}.`, {
      hint: 'Use react-devtools tree, find, inspect, errors, or profile.',
    });
  return output;
}
