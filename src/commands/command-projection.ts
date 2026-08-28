import { createBatchDaemonWriter } from './batch/index.ts';
import type { AnyDaemonWriter, CommandInput, DaemonCommandRequest } from './cli-grammar/types.ts';
import { findCommandMetadata } from './command-metadata.ts';
import { readMetadataCommandFlags } from './command-flags.ts';
import { listCommandFamilyDaemonWriters } from './family/registry.ts';
import { AppError } from '@agent-device/kernel/errors';

const daemonWriters: Record<string, AnyDaemonWriter> = {
  ...listCommandFamilyDaemonWriters(),
  batch: createBatchDaemonWriter(prepareBatchDaemonCommandRequest),
};

export type DaemonCommandName = keyof typeof daemonWriters;

async function prepareBatchDaemonCommandRequest(
  command: string,
  input: CommandInput,
  stepNumber: number,
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
): Promise<DaemonCommandRequest> {
  const writer = daemonWriters[command];
  if (!writer) {
    throw new Error(`Missing daemon writer for command: ${command}`);
  }
  const metadata = findCommandMetadata(command);
  return await prepareRequestWithMetadataFlags(writer, metadata, input);
}

async function prepareRequestWithMetadataFlags(
  writer: AnyDaemonWriter,
  metadata: ReturnType<typeof findCommandMetadata>,
  input: CommandInput,
): Promise<DaemonCommandRequest> {
  const request = await writer(input);
  return {
    ...request,
    ...(metadata ? { metadataFlags: readMetadataCommandFlags(metadata, request.options) } : {}),
  };
}
