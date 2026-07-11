import type { CommandRequestResult } from '../../agent-device-client.ts';
import { runCliCommandWithOutput } from '../../commands/cli-runner.ts';
import type { CommandName } from '../../commands/command-metadata.ts';
import type { CliOutput } from '../../commands/command-contract.ts';
import type { ReplaySuiteResult } from '../../daemon/types.ts';
import type { CliFlags } from '../../commands/cli-grammar/flag-types.ts';
import { readCommandMessage } from '../../utils/success-text.ts';
import { isNonDefaultResponseLevel } from '../../kernel/contracts.ts';
import { writeCommandOutput } from './shared.ts';
import type { ClientBackedCliCommandName } from './client-backed.ts';
import type { ClientCommandParams } from './router-types.ts';

export async function runGenericClientBackedCommand({
  command,
  positionals,
  flags,
  client,
  debug,
  replayTestReporterRuntime,
}: ClientCommandParams & { command: ClientBackedCliCommandName }): Promise<boolean> {
  const { result, cliOutput } = await runCliCommandWithOutput({
    client,
    command: command as CommandName,
    positionals,
    flags,
  });
  // A non-default responseLevel returns a leveled payload (e.g. the snapshot
  // digest { nodeCount, refs }) that the per-command CLI formatters assume away —
  // they serialize the default shape and drop the digest fields. Emit the leveled
  // payload verbatim instead.
  if (isNonDefaultResponseLevel(flags.responseLevel)) {
    writeCommandOutput(flags, result, () => JSON.stringify(result, null, 2));
    return true;
  }
  if (cliOutput) {
    writeCliOutput(flags, cliOutput);
  } else {
    const exitCode = await writeGenericCliOutput(command, flags, result, {
      debug,
      replayTestReporterRuntime,
    });
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
  options: Pick<ClientCommandParams, 'debug' | 'replayTestReporterRuntime'> = {},
): Promise<number> | number {
  if (command === 'test') {
    // Lazy: keeps the replay test reporting runtime off every other command's path.
    return import('../../replay/test/reporting.ts').then(({ renderReplayTestResponse }) =>
      renderReplayTestResponse({
        suite: data as ReplaySuiteResult,
        debug: options.debug,
        verbose: flags.verbose,
        json: flags.json,
        reporter: flags.reporter,
        reportJunit: flags.reportJunit,
        reporterRuntime: options.replayTestReporterRuntime,
      }),
    );
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
