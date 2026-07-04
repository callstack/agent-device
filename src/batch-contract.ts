import { daemonRuntimeSchema, type SessionRuntimeHints } from './kernel/contracts.ts';
import { AppError } from './kernel/errors.ts';
import { isRecord } from './utils/parsing.ts';

export const DEFAULT_BATCH_MAX_STEPS = 100;

export function isValidBatchMaxSteps(maxSteps: number): boolean {
  return Number.isInteger(maxSteps) && maxSteps >= 1 && maxSteps <= 1000;
}

export function assertBatchStepCount(stepCount: number, maxSteps: number): void {
  if (stepCount > maxSteps) {
    throw new AppError('INVALID_ARGS', `batch has ${stepCount} steps; max allowed is ${maxSteps}.`);
  }
}

export function readBatchStepRecord(step: unknown, stepNumber: number): Record<string, unknown> {
  if (!isRecord(step)) {
    throw new AppError('INVALID_ARGS', `Invalid batch step ${stepNumber}.`);
  }
  return step;
}

export function readBatchStepInputObject(
  record: Record<string, unknown>,
  stepNumber: number,
): Record<string, unknown> {
  const input = record.input;
  if (!isRecord(input)) {
    throw new AppError('INVALID_ARGS', `Batch step ${stepNumber} input must be an object.`);
  }
  return input;
}

export function parseBatchStepRuntime(
  value: unknown,
  stepNumber: number,
): SessionRuntimeHints | undefined {
  if (value === undefined) return undefined;
  try {
    return daemonRuntimeSchema.parse(value);
  } catch (error) {
    throw new AppError(
      'INVALID_ARGS',
      `Batch step ${stepNumber} runtime is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
