import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { createBatchDaemonWriter } from './batch/index.ts';
import type { AnyDaemonWriter, CommandInput, DaemonCommandRequest } from './cli-grammar/types.ts';
import { findCommandMetadata } from './command-metadata.ts';
import { refuseRetiredCommonInput } from './common-input-fields.ts';
import { readMetadataCommandFlags } from './command-flags.ts';
import { listCommandFamilyDaemonWriters } from './family/registry.ts';
import { AppError } from '@agent-device/kernel/errors';

export type { AgentDeviceClient, AgentDeviceCommandClient } from './client-port.ts';
export type { CommandMetadata, JsonSchema } from './command-contract.ts';
export type { InputAudience, InputAudienceMap } from './input-audience.ts';
export type { CommandName } from './command-metadata.ts';
export type { CommandExecutionResult } from './command-surface.ts';
export { COMMAND_OUTPUT_SCHEMAS } from './command-output-schemas.ts';
export { COMMON_INPUT_AUDIENCE } from './common-input-fields.ts';
export { operatorAudience, operatorInputRefusal } from './input-audience.ts';
export { buildRequestFlags } from './command-flags.ts';
export { runCommand } from './command-surface.ts';
export { readInputFromCli } from './cli-grammar.ts';
export { readCliBatchStepsJson } from './batch/batch-steps.ts';
export { readMetroPrepareKind } from './metro/prepare-kind.ts';
export {
  findCommandMetadata,
  isCommandName,
  listCommandMetadata,
  listMcpCommandMetadata,
} from './command-metadata.ts';
export { commandFamilyName } from './family/registry.ts';
export {
  assertCommandPositionalArity,
  getCliCommandSchema,
  getCommandSchema,
} from './schema/command-schema.ts';
export { isFlagSupportedForCommand } from './schema/option-schema.ts';
export { resolveConfigBackedFlagDefaults } from './schema/cli-config.ts';
export { mergeDefinedFlags } from './schema/merge-flags.ts';

const daemonWriters: Record<string, AnyDaemonWriter> = {
  ...listCommandFamilyDaemonWriters(),
  batch: createBatchDaemonWriter(prepareBatchDaemonCommandRequest),
};

export type DaemonCommandName = keyof typeof daemonWriters;

async function prepareBatchDaemonCommandRequest(
  command: string,
  input: CommandInput,
  stepNumber: number,
  host: HostEnvironment,
): Promise<DaemonCommandRequest> {
  const writer = (daemonWriters as Readonly<Record<string, AnyDaemonWriter>>)[command];
  if (!writer) {
    throw new Error(`Missing daemon writer for batch command: ${command}`);
  }
  const metadata = findCommandMetadata(command);
  if (!metadata) {
    throw new Error(`Missing command metadata for batch command: ${command}`);
  }
  try {
    return await prepareRequestWithMetadataFlags(
      writer,
      metadata,
      metadata.readInput(input) as CommandInput,
      host,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError(
      'INVALID_ARGS',
      `Batch step ${stepNumber} ${command} input is invalid: ${message}`,
      undefined,
      error,
    );
  }
}

export async function prepareDaemonCommandRequest(
  command: DaemonCommandName,
  input: CommandInput,
  host: HostEnvironment,
): Promise<DaemonCommandRequest> {
  const writer = daemonWriters[command];
  if (!writer) {
    throw new Error(`Missing daemon writer for command: ${command}`);
  }
  refuseRetiredCommonInput(input as Record<string, unknown>);
  const metadata = findCommandMetadata(command);
  return await prepareRequestWithMetadataFlags(writer, metadata, input, host);
}

async function prepareRequestWithMetadataFlags(
  writer: AnyDaemonWriter,
  metadata: ReturnType<typeof findCommandMetadata>,
  input: CommandInput,
  host: HostEnvironment,
): Promise<DaemonCommandRequest> {
  const request = await writer(input, host);
  return {
    ...request,
    ...(metadata ? { metadataFlags: readMetadataCommandFlags(metadata, request.options) } : {}),
  };
}
