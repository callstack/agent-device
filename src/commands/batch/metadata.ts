import {
  BATCH_STEP_SHAPE_HINT,
  DEFAULT_BATCH_MAX_STEPS,
  assertBatchStepCount,
  isValidBatchMaxSteps,
  parseBatchStepRuntime,
  readBatchStepInputObject,
  readBatchStepRecord,
} from '@agent-device/contracts/command';
import { AppError } from '@agent-device/kernel/errors';
import { type SessionRuntimeHints } from '@agent-device/kernel/contracts';
import {
  STRUCTURED_BATCH_COMMAND_NAMES,
  readStructuredBatchCommandName,
} from '../../core/batch-policy.ts';
import { type CommandMetadata, type JsonSchema } from '../command-contract.ts';
import {
  customField,
  enumField,
  integerField,
  readFieldInput,
  requiredField,
  stringField,
  type CommandFieldMap,
  type InferCommandInput,
} from '../command-input.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { assertAllowedKeys } from '../input-readers.ts';

export type BatchCommandStep = {
  command: string;
  input: Record<string, unknown>;
  runtime?: SessionRuntimeHints;
};

export type BatchInput = InferCommandInput<CommandFieldMap> & {
  steps: BatchCommandStep[];
  onError?: 'stop';
  maxSteps?: number;
  out?: string;
};

export function createBatchCommandMetadata(
  nestedCommands: readonly string[] = STRUCTURED_BATCH_COMMAND_NAMES,
): CommandMetadata<'batch', BatchInput> {
  const fields = batchFields(nestedCommands);
  return defineFieldCommandMetadata(
    'batch',
    'Execute multiple commands in one daemon request.',
    fields,
    { readInput: (input) => readBatchInput(input, fields) },
  );
}

function batchFields(nestedCommands: readonly string[]) {
  return {
    steps: requiredField(
      customField<BatchCommandStep[]>(
        {
          type: 'array',
          description:
            'Structured batch steps. Each step uses a command name and the same input object as that command tool.',
          items: batchStepSchema(nestedCommands),
        },
        (record, key) => readBatchSteps(record[key], nestedCommands),
      ),
    ),
    onError: enumField(['stop'] as const, 'Batch failure policy.'),
    maxSteps: integerField('Maximum number of steps accepted for this batch.', {
      min: 1,
      max: 1000,
    }),
    out: stringField('Optional output path for command artifacts.'),
  };
}

function batchStepSchema(nestedCommands: readonly string[]): JsonSchema {
  return {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        enum: nestedCommands,
        description: 'Command name to run with structured input.',
      },
      input: {
        type: 'object',
        additionalProperties: true,
        // The accepted keys depend on `command`, so this object cannot be typed
        // here. `commandInputFor` names the sibling that resolves them, which is
        // what lets the model-facing admission boundary check a step's input
        // against that command's own advertised schema instead of waving through
        // an opaque object (`mcp/command-tools.ts`).
        commandInputFor: 'command',
        description:
          'Structured command input for the nested command. Use the matching MCP tool schema for this object.',
      },
      runtime: {
        type: 'object',
        additionalProperties: true,
        description: 'Optional per-step runtime payload.',
      },
    },
    required: ['command', 'input'],
    additionalProperties: false,
  };
}

function readBatchInput(input: unknown, fields: ReturnType<typeof batchFields>): BatchInput {
  const parsed = readFieldInput(input, fields);
  const maxSteps = parsed.maxSteps ?? DEFAULT_BATCH_MAX_STEPS;
  if (!isValidBatchMaxSteps(maxSteps)) {
    throw new AppError('INVALID_ARGS', `Invalid batch maxSteps: ${String(parsed.maxSteps)}`);
  }
  assertBatchStepCount(parsed.steps.length, maxSteps);
  return {
    ...parsed,
  };
}

function readBatchSteps(steps: unknown, nestedCommands: readonly string[]): BatchCommandStep[] {
  if (!Array.isArray(steps)) {
    throw new AppError('INVALID_ARGS', 'Expected steps to be an array.');
  }
  return steps.map((step, index) => readBatchStep(step, index + 1, nestedCommands));
}

function readBatchStep(
  step: unknown,
  stepNumber: number,
  nestedCommands: readonly string[],
): BatchCommandStep {
  const record = readBatchStepRecord(step, stepNumber);
  assertAllowedKeys(
    record,
    ['command', 'input', 'runtime'],
    `Batch step ${stepNumber}`,
    BATCH_STEP_SHAPE_HINT,
  );
  return {
    command: readBatchStepCommand(record, stepNumber, nestedCommands),
    input: readBatchStepInputObject(record, stepNumber),
    ...readBatchStepRuntimeProperty(record, stepNumber),
  };
}

function readBatchStepCommand(
  record: Record<string, unknown>,
  stepNumber: number,
  nestedCommands: readonly string[],
): string {
  if (nestedCommands === STRUCTURED_BATCH_COMMAND_NAMES) {
    return readStructuredBatchCommandName(record.command, stepNumber);
  }
  const command = record.command;
  if (typeof command !== 'string' || !nestedCommands.includes(command)) {
    throw new AppError(
      'INVALID_ARGS',
      `Expected command to be one of: ${nestedCommands.join(', ')}.`,
    );
  }
  return command;
}

function readBatchStepRuntimeProperty(
  record: Record<string, unknown>,
  stepNumber: number,
): Pick<BatchCommandStep, 'runtime'> {
  const runtime = parseBatchStepRuntime(record.runtime, stepNumber);
  return runtime === undefined ? {} : { runtime };
}
