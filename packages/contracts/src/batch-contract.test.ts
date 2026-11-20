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

  test('an undeclared input key is refused with the closest accepted key', () => {
    expect(() =>
      readBatchStepInputObject(
        { command: 'screenshot', input: { fullscreenn: true } },
        2,
        BATCH_STEP_SHAPE_HINT,
        ACCEPTED,
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'INVALID_ARGS',
        message: 'Batch step 2 input has unknown field(s): fullscreenn. Did you mean fullscreen?',
      }),
    );
  });

  test('a refusal with no confident match states the unknown keys only', () => {
    expect(() =>
      readBatchStepInputObject(
        { command: 'screenshot', input: { output: 'x' } },
        1,
        BATCH_STEP_SHAPE_HINT,
        ACCEPTED,
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'INVALID_ARGS',
        message: 'Batch step 1 input has unknown field(s): output.',
      }),
    );
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
