import { AppError } from '@agent-device/kernel/errors';
import {
  runReactProfileCommand,
  type ReactProfileCommandOptions,
} from '../react-profiler/react-profile-command.ts';

export async function runReactDevtoolsCommand(
  args: string[],
  options: ReactProfileCommandOptions,
): Promise<number> {
  if (args[0] !== 'profile') {
    throw new AppError('INVALID_ARGS', `Unknown react-devtools command: ${args[0] ?? '(none)'}.`, {
      hint: 'Run react-devtools profile start before the interaction and react-devtools profile stop after it.',
    });
  }
  return await runReactProfileCommand(args.slice(1), options);
}
