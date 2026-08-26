import type { BatchStep } from '@agent-device/contracts/client';
import {
  parseBatchStepRuntime,
  readBatchStepInputObject,
  readBatchStepRecord,
} from '@agent-device/contracts/command';
import { AppError } from '@agent-device/kernel/errors';
import { readStructuredBatchCommandName } from '../core/batch-policy.ts';
import { assertAllowedKeys } from '../commands/command-input.ts';

export function readCliBatchStepsJson(raw: string): BatchStep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError('INVALID_ARGS', 'Batch steps must be valid JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new AppError('INVALID_ARGS', 'Batch steps must be a non-empty JSON array.');
  }
  return parsed.map((step, index) => readCliBatchStep(step, index + 1));
}

function readCliBatchStep(step: unknown, stepNumber: number): BatchStep {
  const record = readBatchStepRecord(step, stepNumber);
  const removedFields = ['positionals', 'flags'].filter((field) => field in record);
  if (removedFields.length > 0) {
    const fields = removedFields.map((field) => `"${field}"`).join(', ');
    throw new AppError(
      'INVALID_ARGS',
      `Batch step ${stepNumber} uses removed field(s): ${fields}. Use {"command":"...","input":{...}}. Example: {"command":"open","input":{"app":"settings","platform":"ios"}}.`,
    );
  }
  assertAllowedKeys(record, ['command', 'input', 'runtime'], `Batch step ${stepNumber}`);
  const runtime = parseBatchStepRuntime(record.runtime, stepNumber);
  return {
    command: readStructuredBatchCommandName(record.command, stepNumber),
    input: readBatchStepInputObject(record, stepNumber),
    ...(runtime === undefined ? {} : { runtime }),
  };
}
