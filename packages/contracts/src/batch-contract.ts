import { daemonRuntimeSchema, type SessionRuntimeHints } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from './json.ts';
import { suggestClosestKey } from './key-suggestions.ts';

export const DEFAULT_BATCH_MAX_STEPS = 100;

export function isValidBatchMaxSteps(maxSteps: number): boolean {
  return Number.isInteger(maxSteps) && maxSteps >= 1 && maxSteps <= 1000;
}

export function assertBatchStepCount(stepCount: number, maxSteps: number): void {
  if (stepCount > maxSteps) {
    throw new AppError('INVALID_ARGS', `batch has ${stepCount} steps; max allowed is ${maxSteps}.`);
  }
}

/**
 * The one sentence every batch-step shape refusal owes the caller. `batch` accepts a single step
 * shape, and none of its refusals named it: a string step answered "Invalid batch step 1." and an
 * `args`/`target`/`argv` step answered "unknown field(s)", neither of which says what a step
 * looks like (#2062).
 *
 * It describes the shape only. This module validates for the Node client and the MCP tools as
 * well as the CLI, so a terminal recovery step ("run agent-device help ...") belongs to the CLI
 * call sites, which pass their own hint through the `hint` parameters below.
 */
export const BATCH_STEP_SHAPE_HINT =
  'Each batch step is {"command":"<name>","input":{...}}, where input is that command\'s own ' +
  'structured input object, keyed by field name. There is no positional step form: args, argv, ' +
  'positionals, and flags are not step fields.';

export function readBatchStepRecord(
  step: unknown,
  stepNumber: number,
  hint: string = BATCH_STEP_SHAPE_HINT,
): Record<string, unknown> {
  if (!isRecord(step)) {
    throw new AppError('INVALID_ARGS', `Invalid batch step ${stepNumber}.`, { hint });
  }
  return step;
}

export function readBatchStepInputObject(
  record: Record<string, unknown>,
  stepNumber: number,
  hint: string = BATCH_STEP_SHAPE_HINT,
  allowedKeys?: readonly string[],
): Record<string, unknown> {
  const input = record.input;
  if (!isRecord(input)) {
    throw new AppError('INVALID_ARGS', `Batch step ${stepNumber} input must be an object.`, {
      hint,
    });
  }
  if (allowedKeys !== undefined) assertBatchStepInputKeys(input, stepNumber, allowedKeys, hint);
  return input;
}

/**
 * A step's structured input used to be a pass-through: any key the nested
 * command's field reader does not declare was silently dropped, so a step like
 * `{"command":"screenshot","input":{"out":...}}` ran without its output path
 * and reported success. When the caller passes the nested command's accepted
 * keys, every undeclared key is refused with the closest accepted key, and the
 * refusal still carries the step-shape hint.
 */
function assertBatchStepInputKeys(
  input: Record<string, unknown>,
  stepNumber: number,
  allowedKeys: readonly string[],
  hint: string,
): void {
  const allowed = new Set(allowedKeys);
  const unknownKeys = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknownKeys.length === 0) return;
  const suggestion = suggestClosestKey(unknownKeys[0]!, allowedKeys);
  throw new AppError(
    'INVALID_ARGS',
    `Batch step ${stepNumber} input has unknown field(s): ${unknownKeys.join(', ')}.` +
      (suggestion === undefined ? '' : ` Did you mean ${suggestion}?`),
    { hint },
  );
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
