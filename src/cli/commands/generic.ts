import type { CommandRequestResult } from '../../agent-device-client.ts';
import { runCliCommandWithOutput } from '../../commands/cli-runner.ts';
import type { CommandName } from '../../commands/command-metadata.ts';
import type { CliOutput } from '../../commands/command-contract.ts';
import type { ReplaySuiteResult } from '@agent-device/contracts/replay';
import type { CliFlags } from '@agent-device/contracts/command';
import { readCommandMessage } from '@agent-device/kernel/success-text';
import { isNonDefaultResponseLevel } from '@agent-device/kernel/contracts';
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
    await writeCommandOutput(flags, result, () => JSON.stringify(result, null, 2));
    return true;
  }
  if (cliOutput) {
    await writeCliOutput(flags, cliOutput);
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

async function writeGenericCliOutput(
  command: ClientBackedCliCommandName,
  flags: CliFlags,
  data: CommandRequestResult,
  options: Pick<ClientCommandParams, 'debug' | 'replayTestReporterRuntime'> = {},
): Promise<number> {
  if (command === 'test') {
    // Lazy: keeps the replay test reporting runtime off every other command's path.
    return import('../replay-test/reporting.ts').then(({ renderReplayTestResponse }) =>
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
  await writeCommandOutput(flags, data, () =>
    readCommandMessage(data as Record<string, unknown> | undefined),
  );
  return 0;
}

async function writeCliOutput(flags: CliFlags, output: CliOutput): Promise<void> {
  if (!flags.json && output.stderr) {
    process.stderr.write(output.stderr);
  }
  await writeCommandOutput(
    flags,
    flags.json ? (output.jsonData ?? output.data) : output.data,
    () => output.text,
  );
}
