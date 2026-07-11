import type { AgentDeviceClient, CommandRequestResult } from '../agent-device-client.ts';
import { formatCliOutput } from './cli-output.ts';
import { readInputFromCli } from './cli-grammar.ts';
import { runCommand, type CommandName } from './command-surface.ts';
import type { CliOutput } from './command-contract.ts';
import type { CliFlags } from './cli-grammar/flag-types.ts';

type CliRunOptions = {
  client: AgentDeviceClient;
  command: CommandName;
  positionals: string[];
  flags: CliFlags;
};

export async function runCliCommand(options: CliRunOptions): Promise<CommandRequestResult> {
  return (await runCliCommandWithOutput(options)).result;
}

export async function runCliCommandWithOutput(options: CliRunOptions): Promise<{
  result: CommandRequestResult;
  cliOutput?: CliOutput;
}> {
  const input = readInputFromCli(options.command, options.positionals, options.flags);
  const result = (await runCommand(options.client, options.command, input)) as CommandRequestResult;
  return {
    result,
    cliOutput: formatCliOutput({
      name: options.command,
      input,
      result,
    }),
  };
}
