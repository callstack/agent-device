import { daemonRuntimeSchema, type SessionRuntimeHints } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from './json.ts';

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
 * The typed refusals a batch step's structured input publishes as
 * `details.reason`, so a Node client, MCP agent, or test harness tells them
 * apart from every other INVALID_ARGS error without matching message text.
 * The step-input key refusals of every surface read this one table.
 */
export const BATCH_STEP_INPUT_REFUSALS = {
  unknownKey: { reason: 'batch_step_unknown_input_key' },
  misplacedKey: { reason: 'batch_step_misplaced_input_key' },
} as const satisfies Record<string, Readonly<{ reason: string }>>;

/**
 * A step's structured input used to be a pass-through: any key the nested
 * command's field reader does not declare was silently dropped, so a step like
 * `{"command":"screenshot","input":{"out":...}}` ran without its output path
 * and reported success. When the caller passes the nested command's accepted
 * keys, every undeclared key is refused with the closest accepted key, the
 * refusal still carries the step-shape hint, and `details.reason` plus the
 * unknown keys travel as data, so a client can branch on the refusal without
 * matching message text.
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
    {
      hint,
      reason: BATCH_STEP_INPUT_REFUSALS.unknownKey.reason,
      unknownKeys,
      ...(suggestion === undefined ? {} : { suggestion }),
    },
  );
}

const NEAREST_SUGGESTION_LIMIT = 3;

/**
 * The nearest-name rule behind the "Did you mean ...?" suffixes. It is the CLI
 * parser's rule for command and flag refusals
 * (`src/cli/parser/command-suggestions.ts`), so every surface answers
 * identically: 1-2 character tokens earn no suggestion, exact prefix matches
 * win, only ties at the minimum edit distance are kept, within a
 * length-derived threshold, capped at three and ordered deterministically.
 */
export function suggestClosestKey(
  token: string,
  candidates: readonly string[],
): string | undefined {
  if (token.length <= 2) return undefined;
  const prefixMatches = candidates.filter((name) => name.startsWith(token));
  if (prefixMatches.length > 0) {
    const closest = prefixMatches.sort(shortestThenAlpha).slice(0, NEAREST_SUGGESTION_LIMIT);
    if (closest.length === 1) return closest[0];
    return `one of: ${closest.join(', ')}`;
  }
  const scored = candidates
    .map((name) => ({ name, distance: keyDistance(token, name) }))
    .filter((entry) => entry.distance <= nearestMatchThreshold(token));
  if (scored.length === 0) return undefined;
  const best = Math.min(...scored.map((entry) => entry.distance));
  const closest = scored
    .filter((entry) => entry.distance === best)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, NEAREST_SUGGESTION_LIMIT)
    .map((entry) => entry.name);
  if (closest.length === 1) return closest[0];
  return `one of: ${closest.join(', ')}`;
}

function shortestThenAlpha(a: string, b: string): number {
  return a.length - b.length || a.localeCompare(b);
}

function nearestMatchThreshold(token: string): number {
  if (token.length < 4) return 1;
  if (token.length <= 6) return 2;
  return 3;
}

function keyDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.startsWith(b) || b.startsWith(a)) {
    return Math.abs(a.length - b.length);
  }
  return levenshteinDistance(a, b);
}

function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const distances: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) distances[i]![0] = i;
  for (let j = 0; j < cols; j += 1) distances[0]![j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      distances[i]![j] = Math.min(
        distances[i - 1]![j]! + 1,
        distances[i]![j - 1]! + 1,
        distances[i - 1]![j - 1]! + cost,
      );
    }
  }
  return distances[rows - 1]![cols - 1]!;
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
