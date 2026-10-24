import type { CommandRequestResult } from '../../agent-device-client.ts';
import { runCliCommandWithOutput } from '../../commands/cli-runner.ts';
import { isParseableOutputCommand } from '../../commands/cli-output.ts';
import { routeResponseWarnings } from '../../commands/output-common.ts';
import type { CommandName } from '../../commands/command-metadata.ts';
import type { ReplaySuiteResult } from '@agent-device/contracts/replay';
import type { CliFlags } from '@agent-device/contracts/command';
import { readCommandMessage } from '@agent-device/kernel/success-text';
import { isNonDefaultResponseLevel } from '@agent-device/kernel/contracts';
import { writeCommandOutput, writeCliOutput } from './shared.ts';
import type { ClientBackedCliCommandName } from './client-backed.ts';
import type { ClientCommandParams } from './router-types.ts';
import type { CliOutput } from '../../commands/command-contract.ts';
import type { LeaseDevice } from '@agent-device/contracts/client';
import { isRecord } from '@agent-device/kernel/record';

export async function runGenericClientBackedCommand({
  command,
  positionals,
  flags,
  client,
  host,
  debug,
  replayTestReporterRuntime,
  commandProgress,
  leaseDevice,
}: ClientCommandParams & { command: ClientBackedCliCommandName }): Promise<boolean> {
  const { result, cliOutput: formatted } = await runCliCommandWithOutput({
    client,
    command: command as CommandName,
    positionals,
    flags,
    commandProgress,
    env: host.env,
  });
  const cliOutput =
    command === 'open' && formatted && leaseDevice
      ? withLeaseDevice(formatted, leaseDevice)
      : formatted;
  // A non-default responseLevel returns a leveled payload (e.g. the snapshot
  // digest { nodeCount, refs }) that the per-command CLI formatters assume away —
  // they serialize the default shape and drop the digest fields. Emit the leveled
  // payload verbatim instead.
  if (isNonDefaultResponseLevel(flags.responseLevel)) {
    const leveled =
      command === 'open' && leaseDevice && isRecord(result)
        ? { ...result, lease: { device: leaseDevice } }
        : result;
    await writeCommandOutput(flags, leveled, () => JSON.stringify(leveled, null, 2));
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
  // A command with no formatter still owes the response's warnings: it renders through the same
  // router, on the stream its descriptor says its caller reads (#2682).
  await writeCliOutput(
    flags,
    routeResponseWarnings(
      { data, text: readCommandMessage(data as Record<string, unknown> | undefined) },
      data,
      isParseableOutputCommand(command as CommandName) ? 'stderr' : 'text',
    ),
  );
  return 0;
}

/** Adds the device a proxy backend granted for the lease's device spec to the `open` output. */
function withLeaseDevice(output: CliOutput, device: LeaseDevice): CliOutput {
  const lease = { lease: { device } };
  const facts = [
    device.model,
    device.osVersion,
    device.imageTag,
    device.physical ? 'physical' : 'virtual',
  ].filter((fact): fact is string => Boolean(fact));
  const leasedLine = `Leased device: ${facts.join(', ')}`;
  return {
    ...output,
    data: isRecord(output.data) ? { ...output.data, ...lease } : output.data,
    ...(isRecord(output.jsonData) ? { jsonData: { ...output.jsonData, ...lease } } : {}),
    text: output.text ? `${output.text}\n${leasedLine}` : leasedLine,
  };
}
