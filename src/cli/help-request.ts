import { usage, usageForCommand } from './parser/args.ts';
import { suggestCommandFor } from './parser/command-suggestions.ts';
import { AppError } from '@agent-device/kernel/errors';
import type { resolveCliOptions } from './resolve-cli-options.ts';
import { exitAfterFlush } from './process-exit.ts';
import { printHumanError } from './failure-output.ts';

/** The `--help` and `help <command>` routes: each answers and ends the invocation. `isHelpAlias`
 * names the help topic by positional, the flag by the command itself. */
export async function exitOnHelpRequest(
  parsed: ReturnType<typeof resolveCliOptions>,
  isHelpAlias: boolean,
): Promise<never> {
  if (isHelpAlias && parsed.positionals.length > 1) {
    await printHumanError(new AppError('INVALID_ARGS', 'help accepts at most one command.'));
    return exitAfterFlush(1);
  }
  const helpTarget = isHelpAlias ? parsed.positionals[0] : parsed.command;
  if (!helpTarget) {
    process.stdout.write(`${await usage()}\n`);
    return exitAfterFlush(0);
  }
  const commandHelp = await usageForCommand(helpTarget);
  if (commandHelp) {
    process.stdout.write(commandHelp);
    return exitAfterFlush(0);
  }
  const hint = suggestCommandFor(helpTarget);
  await printHumanError(
    new AppError(
      'INVALID_ARGS',
      hint
        ? `Unknown command: ${helpTarget}. Did you mean ${hint}?`
        : `Unknown command: ${helpTarget}`,
    ),
  );
  process.stdout.write(`${await usage()}\n`);
  return exitAfterFlush(1);
}
