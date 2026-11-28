import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import {
  BATCH_STEP_REASONS,
  STRUCTURED_BATCH_COMMAND_NAMES,
  readStructuredBatchCommandName,
} from '@agent-device/command-registry/batch-policy';
import {
  BATCH_STEP_SHAPE_HINT,
  parseBatchStepRuntime,
  readBatchStepInputObject,
  readBatchStepRecord,
  type DaemonBatchStep,
} from '@agent-device/contracts/command';
import { AppError } from '@agent-device/kernel/errors';
import { commandInputKeys } from '../command-metadata.ts';
import { request } from '../cli-grammar/common.ts';
import type {
  AsyncDaemonWriter,
  CommandInput,
  DaemonCommandRequest,
} from '../cli-grammar/types.ts';
import { buildRequestFlags } from '../command-flags.ts';

export type BatchCommandName = (typeof STRUCTURED_BATCH_COMMAND_NAMES)[number];

type PrepareDaemonCommandRequest = (
  command: string,
  input: CommandInput,
  stepNumber: number,
  host: HostEnvironment,
) => Promise<DaemonCommandRequest>;

type PrepareBatchStep = (
  command: string,
  input: CommandInput,
  stepNumber: number,
) => Promise<DaemonCommandRequest>;

export function createBatchDaemonWriter(
  prepareDaemonCommandRequest: PrepareDaemonCommandRequest,
): AsyncDaemonWriter {
  return async (input, host) =>
    request(PUBLIC_COMMANDS.batch, [], {
      ...input,
      batchSteps: await readBatchDaemonSteps(input.steps, (command, input, stepNumber) =>
        prepareDaemonCommandRequest(command, input, stepNumber, host),
      ),
      batchOnError: input.onError,
      batchMaxSteps: input.maxSteps,
    });
}

async function readBatchDaemonSteps(
  steps: unknown,
  prepareDaemonCommandRequest: PrepareBatchStep,
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
  prepareDaemonCommandRequest: PrepareBatchStep,
): Promise<DaemonBatchStep> {
  const record = readBatchStepRecord(step, stepNumber);
  const command = readBatchStepCommand(record, stepNumber);
  // The last reader every surface's steps cross, so the nested command's
  // unknown-key refusal runs here too: a Node client step skips the CLI and
  // tool readers, and its undeclared keys would otherwise reach the field
  // projection and be dropped without a trace.
  const input = readBatchStepInputObject(
    record,
    stepNumber,
    BATCH_STEP_SHAPE_HINT,
    commandInputKeys(command),
  ) as CommandInput;
  assertNoStdinFillStep(command, input, stepNumber);
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

function assertNoStdinFillStep(
  command: BatchCommandName,
  input: CommandInput,
  stepNumber: number,
): void {
  if (command !== PUBLIC_COMMANDS.fill || input.textStdin !== true) return;
  throw new AppError(
    'INVALID_ARGS',
    `Batch step ${stepNumber}: fill textStdin is not supported because batch steps have no stdin of their own. Run that fill on its own with --text-stdin.`,
    { reason: BATCH_STEP_REASONS.fillTextStdin.reason },
  );
}

function readBatchStepCommand(
  record: Record<string, unknown>,
  stepNumber: number,
): BatchCommandName {
  return readStructuredBatchCommandName(record.command, stepNumber);
}
