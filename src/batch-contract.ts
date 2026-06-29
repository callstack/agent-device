import { daemonRuntimeSchema, type SessionRuntimeHints } from './contracts.ts';
import { AppError } from './kernel/errors.ts';
import { isRecord } from './utils/parsing.ts';

export const DEFAULT_BATCH_MAX_STEPS = 100;

// Builds the error thrown by a batch-step validator, so each consumer keeps its
// own thrown type (plain `Error` for metadata, `AppError` for the daemon/CLI)
// while sharing the validation logic and messages.
export type BatchStepErrorFactory = (message: string) => Error;

const batchInvalidArgsError: BatchStepErrorFactory = (message) =>
  new AppError('INVALID_ARGS', message);

export function isValidBatchMaxSteps(maxSteps: number): boolean {
  return Number.isInteger(maxSteps) && maxSteps >= 1 && maxSteps <= 1000;
}

export function assertBatchStepCount(
  stepCount: number,
  maxSteps: number,
  makeError: BatchStepErrorFactory = batchInvalidArgsError,
): void {
  if (stepCount > maxSteps) {
    throw makeError(`batch has ${stepCount} steps; max allowed is ${maxSteps}.`);
  }
}

export function readBatchStepRecord(
  step: unknown,
  stepNumber: number,
  makeError: BatchStepErrorFactory = batchInvalidArgsError,
): Record<string, unknown> {
  if (!isRecord(step)) {
    throw makeError(`Invalid batch step ${stepNumber}.`);
  }
  return step;
}

export function readBatchStepInputObject(
  record: Record<string, unknown>,
  stepNumber: number,
  makeError: BatchStepErrorFactory = batchInvalidArgsError,
): Record<string, unknown> {
  const input = record.input;
  if (!isRecord(input)) {
    throw makeError(`Batch step ${stepNumber} input must be an object.`);
  }
  return input;
}

export function parseBatchStepRuntime(
  value: unknown,
  stepNumber: number,
  makeError: BatchStepErrorFactory = batchInvalidArgsError,
): SessionRuntimeHints | undefined {
  if (value === undefined) return undefined;
  try {
    return daemonRuntimeSchema.parse(value);
  } catch (error) {
    throw makeError(
      `Batch step ${stepNumber} runtime is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
