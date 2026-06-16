import type { CommandRequestResult } from '../../client.ts';
import { renderReplayTestResponse } from '../../cli-test.ts';
import { runCliCommandWithOutput } from '../../commands/cli-runner.ts';
import type { CommandName } from '../../commands/command-metadata.ts';
import type { CliOutput } from '../../commands/command-contract.ts';
import type { ReplaySuiteResult } from '../../daemon/types.ts';
import type { CliFlags } from '../../utils/cli-flags.ts';
import { readCommandMessage } from '../../utils/success-text.ts';
import { writeCommandOutput } from './shared.ts';
import type { ClientBackedCliCommandName } from '../../command-catalog.ts';
import type { ClientCommandParams } from './router-types.ts';

export async function runGenericClientBackedCommand({
  command,
  positionals,
  flags,
  client,
  debug,
}: ClientCommandParams & { command: ClientBackedCliCommandName }): Promise<boolean> {
  const { result, cliOutput } = await runCliCommandWithOutput({
    client,
    command: command as CommandName,
    positionals,
    flags,
  });
  if (cliOutput) {
    writeCliOutput(flags, cliOutput);
  } else {
    const exitCode = writeGenericCliOutput(command, flags, result, { debug });
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  }
  return true;
}

function writeGenericCliOutput(
  command: ClientBackedCliCommandName,
  flags: CliFlags,
  data: CommandRequestResult,
  options: { debug?: boolean } = {},
): number {
  if (command === 'test') {
    return renderReplayTestResponse({
      suite: data as ReplaySuiteResult,
      debug: options.debug,
      json: flags.json,
      reportJunit: flags.reportJunit,
    });
  }
  writeCommandOutput(flags, data, () =>
    readCommandMessage(data as Record<string, unknown> | undefined),
  );
  return 0;
}

function writeCliOutput(flags: CliFlags, output: CliOutput): void {
  if (!flags.json && output.stderr) {
    process.stderr.write(output.stderr);
  }
  writeCommandOutput(
    flags,
    flags.json ? (output.jsonData ?? output.data) : output.data,
    () => output.text,
  );
}
