import { AppError } from '@agent-device/kernel/errors';
import { usage, usageForCommand } from './parser/args.ts';
import { suggestCommandFor } from './parser/command-suggestions.ts';
import { exitAfterFlush } from './process-exit.ts';
import type { resolveCliOptions } from './resolve-cli-options.ts';

export async function exitAfterHelp(
  parsed: ReturnType<typeof resolveCliOptions>,
  isHelpAlias: boolean,
): Promise<never> {
  if (isHelpAlias && parsed.positionals.length > 1) {
    await (
      await import('./failure-output.ts')
    ).printHumanError(new AppError('INVALID_ARGS', 'help accepts at most one command.'));
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
  await (
    await import('./failure-output.ts')
  ).printHumanError(new AppError('INVALID_ARGS', formatUnknownHelpTargetMessage(helpTarget)));
  process.stdout.write(`${await usage()}\n`);
  return exitAfterFlush(1);
}

function formatUnknownHelpTargetMessage(helpTarget: string): string {
  const hint = suggestCommandFor(helpTarget);
  return hint
    ? `Unknown command: ${helpTarget}. Did you mean ${hint}?`
    : `Unknown command: ${helpTarget}`;
}
