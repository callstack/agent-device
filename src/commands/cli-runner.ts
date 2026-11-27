import {
  formatCliOutput,
  type CliOutput,
  type CommandProgressState,
} from '@agent-device/command-output';
import { registerDiagnosticSensitiveValue } from '@agent-device/host-kit/diagnostics';
import type { EnvMap } from '@agent-device/kernel/source-value';
import type { CommandRequestResult } from '@agent-device/contracts/client';
import { readFillTextFromStdin } from './interaction/fill-text-stdin.ts';
import {
  readInputFromCli,
  runCommand,
  type AgentDeviceClient,
  type CommandName,
} from '@agent-device/command-surface';
import type { CliFlags } from '@agent-device/contracts/command';

/** Input a CLI run can read only once. A rerun of the command reuses what is here. */
export type CliRunInputs = {
  /** The `fill --text-stdin` value. */
  fillText?: Promise<string>;
};

type CliRunOptions = {
  client: AgentDeviceClient;
  command: CommandName;
  positionals: string[];
  flags: CliFlags;
  commandProgress?: CommandProgressState;
  inputs?: CliRunInputs;
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
    const inputs = options.inputs ?? {};
    const text = await (inputs.fillText ??= readFillTextFromStdin(process.stdin));
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
      stderrIsTTY: Boolean(process.stderr.isTTY),
    }),
  };
}
