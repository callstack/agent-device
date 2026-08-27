import type { BatchStep } from '@agent-device/contracts/client';
import {
  BATCH_STEP_SHAPE_HINT,
  parseBatchStepRuntime,
  readBatchStepInputObject,
  readBatchStepRecord,
} from '@agent-device/contracts/command';
import { AppError } from '@agent-device/kernel/errors';
import {
  BATCH_AVAILABLE_COMMANDS_HINT,
  readStructuredBatchCommandName,
} from '../core/batch-policy.ts';
import { assertAllowedKeys } from '../commands/input-readers.ts';

/**
 * The terminal half of the step-shape refusal. `@agent-device/contracts` states the shape for
 * every surface and stops there; only a terminal caller can be told to run a help command, so the
 * recovery step is attached here rather than in the shared contract (#2062).
 */
const CLI_BATCH_STEP_SHAPE_HINT = `${BATCH_STEP_SHAPE_HINT} Run agent-device help batch for the commands batch accepts and for runnable step examples.`;

const CLI_BATCH_AVAILABLE_COMMANDS_HINT = `${BATCH_AVAILABLE_COMMANDS_HINT} Run agent-device help batch for the commands batch accepts and for runnable step examples.`;

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
  const record = readBatchStepRecord(step, stepNumber, CLI_BATCH_STEP_SHAPE_HINT);
  const removedFields = ['positionals', 'flags'].filter((field) => field in record);
  if (removedFields.length > 0) {
    const fields = removedFields.map((field) => `"${field}"`).join(', ');
    throw new AppError(
      'INVALID_ARGS',
      `Batch step ${stepNumber} uses removed field(s): ${fields}. Use {"command":"...","input":{...}}. Example: {"command":"open","input":{"app":"settings","platform":"ios"}}.`,
      { hint: CLI_BATCH_STEP_SHAPE_HINT },
    );
  }
  assertAllowedKeys(
    record,
    ['command', 'input', 'runtime'],
    `Batch step ${stepNumber}`,
    CLI_BATCH_STEP_SHAPE_HINT,
  );
  const runtime = parseBatchStepRuntime(record.runtime, stepNumber);
  return {
    command: readStructuredBatchCommandName(
      record.command,
      stepNumber,
      CLI_BATCH_AVAILABLE_COMMANDS_HINT,
    ),
    input: readBatchStepInputObject(record, stepNumber, CLI_BATCH_STEP_SHAPE_HINT),
    ...(runtime === undefined ? {} : { runtime }),
  };
}
