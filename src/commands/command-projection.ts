import { createBatchDaemonWriter, type BatchCommandName } from './batch/index.ts';
import { captureDaemonWriters } from './capture/index.ts';
import type { CommandInput, DaemonCommandRequest, DaemonWriter } from './cli-grammar/types.ts';
import {
  gestureDaemonWriters,
  interactionDaemonWriters,
  selectorDaemonWriters,
} from './interaction/index.ts';
import { appDaemonWriters } from './management/index.ts';
import { observabilityDaemonWriters } from './observability/index.ts';
import { perfDaemonWriters } from './perf/index.ts';
import { reactNativeDaemonWriters } from './react-native/index.ts';
import { recordingDaemonWriters } from './recording/index.ts';
import { replayDaemonWriters } from './replay/index.ts';
import { systemDaemonWriters } from './system/index.ts';
import { findCommandMetadata } from './command-metadata.ts';
import { AppError } from '../utils/errors.ts';

const daemonWriters = {
  ...appDaemonWriters,
  ...captureDaemonWriters,
  ...interactionDaemonWriters,
  ...gestureDaemonWriters,
  ...selectorDaemonWriters,
  ...observabilityDaemonWriters,
  ...perfDaemonWriters,
  ...reactNativeDaemonWriters,
  ...recordingDaemonWriters,
  ...replayDaemonWriters,
  ...systemDaemonWriters,
  batch: createBatchDaemonWriter(prepareBatchDaemonCommandRequest),
} satisfies Record<string, DaemonWriter>;

export type DaemonCommandName = keyof typeof daemonWriters;

export type { BatchCommandName };

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
    return writer(metadata.readInput(input) as CommandInput);
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
  return daemonWriters[command](input);
}
