import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import {
  STRUCTURED_BATCH_COMMAND_NAMES,
  readStructuredBatchCommandName,
} from '../../core/batch-policy.ts';
import {
  parseBatchStepRuntime,
  readBatchStepInputObject,
  readBatchStepRecord,
  type DaemonBatchStep,
} from '@agent-device/contracts/command';
import { AppError } from '@agent-device/kernel/errors';
import { request } from '../cli-grammar/common.ts';
import type {
  AsyncDaemonWriter,
  CommandInput,
  DaemonCommandRequest,
} from '../cli-grammar/types.ts';
import { buildRequestFlags } from '../command-flags.ts';
import type { DaemonCommandName } from '../command-projection.ts';

const batchCommandNames = STRUCTURED_BATCH_COMMAND_NAMES satisfies readonly DaemonCommandName[];

export type BatchCommandName = (typeof batchCommandNames)[number];

type PrepareDaemonCommandRequest = (
  command: string,
  input: CommandInput,
  stepNumber: number,
) => Promise<DaemonCommandRequest>;

export function createBatchDaemonWriter(
  prepareDaemonCommandRequest: PrepareDaemonCommandRequest,
): AsyncDaemonWriter {
  return async (input) =>
    request(PUBLIC_COMMANDS.batch, [], {
      ...input,
      batchSteps: await readBatchDaemonSteps(input.steps, prepareDaemonCommandRequest),
      batchOnError: input.onError,
      batchMaxSteps: input.maxSteps,
    });
}

async function readBatchDaemonSteps(
  steps: unknown,
  prepareDaemonCommandRequest: PrepareDaemonCommandRequest,
): Promise<DaemonBatchStep[]> {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new AppError('INVALID_ARGS', 'batch requires a non-empty steps array.');
  }
  // Sequential, not `Promise.all`: a step's rejection is reported with its own step number, and
  // preparing step N+1 after N keeps that number the first failure a caller sees.
  const prepared: DaemonBatchStep[] = [];
  for (const [index, step] of steps.entries()) {
    prepared.push(await readBatchDaemonStep(step, index + 1, prepareDaemonCommandRequest));
  }
  return prepared;
}

async function readBatchDaemonStep(
  step: unknown,
  stepNumber: number,
  prepareDaemonCommandRequest: PrepareDaemonCommandRequest,
): Promise<DaemonBatchStep> {
  const record = readBatchStepRecord(step, stepNumber);
  const command = readBatchStepCommand(record, stepNumber);
  const input = readBatchStepInputObject(record, stepNumber) as CommandInput;
  const runtime = parseBatchStepRuntime(record.runtime, stepNumber);
  const prepared = await prepareDaemonCommandRequest(command, input, stepNumber);
  return {
    command: prepared.command,
    positionals: prepared.positionals,
    ...(prepared.input ? { input: prepared.input } : {}),
    flags: buildRequestFlags(prepared.options, prepared.metadataFlags),
    runtime: runtime ?? prepared.options.runtime,
  };
}

function readBatchStepCommand(
  record: Record<string, unknown>,
  stepNumber: number,
): BatchCommandName {
  return readStructuredBatchCommandName(record.command, stepNumber);
}
