import { describe, expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  BATCH_STEP_SHAPE_HINT,
  readBatchStepInputObject,
  readBatchStepRecord,
} from './batch-contract.ts';

function hintOf(read: () => unknown): string | undefined {
  try {
    read();
  } catch (error) {
    return error instanceof AppError ? error.details?.hint : undefined;
  }
  throw new Error('Expected the read to refuse');
}

// A client tells this refusal apart from every other INVALID_ARGS by its typed
// reason and keys, never by message text: the unknown keys and the nearest
// accepted spelling travel as data alongside the message.
function refusalOf(read: () => unknown): AppError {
  try {
    read();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('Expected the read to refuse');
}

// This module validates batch steps for the Node client and the MCP tools as well as the CLI, so
// a terminal recovery step here would be unrunnable advice on two of the three surfaces (#2062).
test('the shared step-shape hint names the shape without naming a surface', () => {
  expect(BATCH_STEP_SHAPE_HINT).toContain('{"command":"<name>","input":{...}}');
  expect(BATCH_STEP_SHAPE_HINT).not.toMatch(/agent-device |--\w/);
});

test('shape refusals carry the shared hint, or the caller-supplied one', () => {
  expect(hintOf(() => readBatchStepRecord('press @e12', 1))).toBe(BATCH_STEP_SHAPE_HINT);
  expect(hintOf(() => readBatchStepInputObject({ command: 'press' }, 1))).toBe(
    BATCH_STEP_SHAPE_HINT,
  );
  expect(hintOf(() => readBatchStepRecord('press @e12', 1, 'surface hint'))).toBe('surface hint');
  expect(hintOf(() => readBatchStepInputObject({ command: 'press' }, 1, 'surface hint'))).toBe(
    'surface hint',
  );
});

describe('input key admission', () => {
  const ACCEPTED = ['path', 'fullscreen', 'platform'];

  // The nearest-name rule is the CLI parser's command and flag suggestion rule,
  // exercised here through the reader's "Did you mean" suffix: a one-edit typo
  // or a prefix names the single closest key, and a short or distant token
  // earns no suggestion at all. A declared key never reaches the rule: the
  // read accepts it untouched (see the pass-through test below). Each refusal
  // asserts `batch_step_unknown_input_key` and the keys as data, so the typed
  // reason, not the message, is what a client branches on.
  test.each([
    ['fullscren', 'fullscreen'],
    ['scal', 'scale'],
    ['full', 'fullscreen'],
    ['pa', undefined],
    ['output', undefined],
  ])('the unknown key %s recovers with the nearest accepted key, or none', (token, suggestion) => {
    const refusal = refusalOf(() =>
      readBatchStepInputObject(
        { command: 'screenshot', input: { [token]: true } },
        1,
        BATCH_STEP_SHAPE_HINT,
        ['path', 'fullscreen', 'cropOn', 'scale'],
      ),
    );
    expect(refusal.code).toBe('INVALID_ARGS');
    expect(refusal.message).toBe(
      suggestion === undefined
        ? `Batch step 1 input has unknown field(s): ${token}.`
        : `Batch step 1 input has unknown field(s): ${token}. Did you mean ${suggestion}?`,
    );
    expect(refusal.details).toMatchObject({
      hint: BATCH_STEP_SHAPE_HINT,
      reason: 'batch_step_unknown_input_key',
      unknownKeys: [token],
    });
    expect(refusal.details?.suggestion).toBe(suggestion);
  });

  test('distance ties are answered with the whole set, in order', () => {
    const refusal = refusalOf(() =>
      readBatchStepInputObject(
        { command: 'screenshot', input: { pathh: true } },
        1,
        BATCH_STEP_SHAPE_HINT,
        ['path', 'patch', 'pause'],
      ),
    );
    expect(refusal.message).toBe(
      'Batch step 1 input has unknown field(s): pathh. Did you mean one of: patch, path?',
    );
    expect(refusal.details).toMatchObject({
      reason: 'batch_step_unknown_input_key',
      unknownKeys: ['pathh'],
      suggestion: 'one of: patch, path',
    });
  });

  test('an undeclared key refusal still carries the caller-supplied hint', () => {
    expect(
      hintOf(() =>
        readBatchStepInputObject(
          { command: 'screenshot', input: { fullscren: true } },
          3,
          'surface hint',
          ACCEPTED,
        ),
      ),
    ).toBe('surface hint');
  });

  test('declared keys pass through untouched', () => {
    expect(
      readBatchStepInputObject(
        { command: 'screenshot', input: { path: 'a.png', platform: 'ios' } },
        1,
        BATCH_STEP_SHAPE_HINT,
        ACCEPTED,
      ),
    ).toEqual({ path: 'a.png', platform: 'ios' });
  });

  test('without accepted keys the read stays shape-only', () => {
    expect(
      readBatchStepInputObject({ command: 'screenshot', input: { anything: true } }, 1),
    ).toEqual({ anything: true });
  });
});
