import { createBatchDaemonWriter } from './batch/index.ts';
import type { CommandInput, DaemonCommandRequest, DaemonWriter } from './cli-grammar/types.ts';
import { findCommandMetadata } from './command-metadata.ts';
import { readMetadataCommandFlags } from './command-flags.ts';
import { listCommandFamilyDaemonWriters } from './family/registry.ts';
import { AppError } from '../kernel/errors.ts';

const daemonWriters: Record<string, DaemonWriter> = {
  ...listCommandFamilyDaemonWriters(),
  batch: createBatchDaemonWriter(prepareBatchDaemonCommandRequest),
};

export type DaemonCommandName = keyof typeof daemonWriters;

function prepareBatchDaemonCommandRequest(
  command: string,
  input: CommandInput,
  stepNumber: number,
): DaemonCommandRequest {
  const writer = (daemonWriters as Readonly<Record<string, DaemonWriter>>)[command];
  if (!writer) {
    throw new Error(`Missing daemon writer for batch command: ${command}`);
  }
  const metadata = findCommandMetadata(command);
  if (!metadata) {
    throw new Error(`Missing command metadata for batch command: ${command}`);
  }
  try {
    return prepareRequestWithMetadataFlags(
      writer,
      metadata,
      metadata.readInput(input) as CommandInput,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError(
      'INVALID_ARGS',
      `Batch step ${stepNumber} ${command} input is invalid: ${message}`,
      undefined,
      err,
    );
  }
}

export function prepareDaemonCommandRequest(
  command: DaemonCommandName,
  input: CommandInput,
): DaemonCommandRequest {
  const writer = daemonWriters[command];
  if (!writer) {
    throw new Error(`Missing daemon writer for command: ${command}`);
  }
  const metadata = findCommandMetadata(command);
  return prepareRequestWithMetadataFlags(writer, metadata, input);
}

function prepareRequestWithMetadataFlags(
  writer: DaemonWriter,
  metadata: ReturnType<typeof findCommandMetadata>,
  input: CommandInput,
): DaemonCommandRequest {
  const request = writer(input);
  return {
    ...request,
    ...(metadata ? { metadataFlags: readMetadataCommandFlags(metadata, request.options) } : {}),
  };
}
