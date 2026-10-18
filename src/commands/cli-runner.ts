import { registerDiagnosticSensitiveValue } from '@agent-device/host-kit/diagnostics';
import type { EnvMap } from '@agent-device/kernel/source-value';
import type { AgentDeviceClient, CommandRequestResult } from '../agent-device-client.ts';
import { readFillTextFromStdin } from './interaction/fill-text-stdin.ts';
import { formatCliOutput } from './cli-output.ts';
import { readInputFromCli } from './cli-grammar.ts';
import { runCommand, type CommandName } from './command-surface.ts';
import type { CliOutput } from './command-contract.ts';
import type { CliFlags } from '@agent-device/contracts/command';
import type { CommandProgressState } from './command-progress.ts';

type CliRunOptions = {
  client: AgentDeviceClient;
  command: CommandName;
  positionals: string[];
  flags: CliFlags;
  commandProgress?: CommandProgressState;
  /** The CLI run's own host environment; output formatters read styling from it (#3794). */
  env: EnvMap;
};

export async function runCliCommand(options: CliRunOptions): Promise<CommandRequestResult> {
  return (await runCliCommandWithOutput(options)).result;
}

export async function runCliCommandWithOutput(options: CliRunOptions): Promise<{
  result: CommandRequestResult;
  cliOutput?: CliOutput;
}> {
  const input = readInputFromCli(options.command, options.positionals, options.flags);
  if (options.flags.textStdin) {
    const text = await readFillTextFromStdin(process.stdin);
    registerDiagnosticSensitiveValue(text);
    input.text = text;
  }
  const result = (await runCommand(options.client, options.command, input)) as CommandRequestResult;
  return {
    result,
    cliOutput: await formatCliOutput({
      name: options.command,
      input,
      result,
      progress: options.commandProgress,
      env: options.env,
    }),
  };
}
