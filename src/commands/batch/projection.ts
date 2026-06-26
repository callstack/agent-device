import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { daemonRuntimeSchema, type DaemonRequest } from '../../contracts.ts';
import {
  STRUCTURED_BATCH_COMMAND_NAMES,
  readStructuredBatchCommandName,
} from '../../batch-policy.ts';
import type { DaemonBatchStep } from '../../core/batch.ts';
import { AppError } from '../../utils/errors.ts';
import { isRecord } from '../../utils/parsing.ts';
import { request } from '../cli-grammar/common.ts';
import type { CommandInput, DaemonCommandRequest, DaemonWriter } from '../cli-grammar/types.ts';
import { buildRequestFlags } from '../command-flags.ts';
import type { DaemonCommandName } from '../command-projection.ts';

const batchCommandNames = STRUCTURED_BATCH_COMMAND_NAMES satisfies readonly DaemonCommandName[];

export type BatchCommandName = (typeof batchCommandNames)[number];

type PrepareDaemonCommandRequest = (
  command: string,
  input: CommandInput,
  stepNumber: number,
) => DaemonCommandRequest;

export function createBatchDaemonWriter(
  prepareDaemonCommandRequest: PrepareDaemonCommandRequest,
): DaemonWriter {
  return (input) =>
    request(PUBLIC_COMMANDS.batch, [], {
      ...input,
      batchSteps: readBatchDaemonSteps(input.steps, prepareDaemonCommandRequest),
      batchOnError: input.onError,
      batchMaxSteps: input.maxSteps,
    });
}

function readBatchDaemonSteps(
  steps: unknown,
  prepareDaemonCommandRequest: PrepareDaemonCommandRequest,
): DaemonBatchStep[] {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new AppError('INVALID_ARGS', 'batch requires a non-empty steps array.');
  }
  return steps.map((step, index) =>
    readBatchDaemonStep(step, index + 1, prepareDaemonCommandRequest),
  );
}

function readBatchDaemonStep(
  step: unknown,
  stepNumber: number,
  prepareDaemonCommandRequest: PrepareDaemonCommandRequest,
): DaemonBatchStep {
  const record = readBatchStepRecord(step, stepNumber);
  const command = readBatchStepCommand(record, stepNumber);
  const input = readBatchStepInput(record, stepNumber);
  const runtime = readBatchStepRuntime(record, stepNumber);
  const prepared = prepareDaemonCommandRequest(command, input, stepNumber);
  return {
    command: prepared.command,
    positionals: prepared.positionals,
    flags: buildRequestFlags(prepared.options, prepared.metadataFlags),
    runtime: runtime ?? prepared.options.runtime,
  };
}

function readBatchStepRecord(step: unknown, stepNumber: number): Record<string, unknown> {
  if (!isRecord(step)) {
    throw new AppError('INVALID_ARGS', `Invalid batch step ${stepNumber}.`);
  }
  return step;
}

function readBatchStepCommand(
  record: Record<string, unknown>,
  stepNumber: number,
): BatchCommandName {
  return readStructuredBatchCommandName(record.command, stepNumber);
}

function readBatchStepInput(record: Record<string, unknown>, stepNumber: number): CommandInput {
  const input = record.input;
  if (!isRecord(input)) {
    throw new AppError('INVALID_ARGS', `Batch step ${stepNumber} input must be an object.`);
  }
  return input as CommandInput;
}

function readBatchStepRuntime(
  record: Record<string, unknown>,
  stepNumber: number,
): DaemonRequest['runtime'] {
  const runtime = record.runtime;
  if (runtime === undefined) return undefined;
  try {
    return daemonRuntimeSchema.parse(runtime);
  } catch (error) {
    throw new AppError(
      'INVALID_ARGS',
      `Batch step ${stepNumber} runtime is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
