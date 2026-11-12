import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import {
  MAX_RUNNER_SEQUENCE_STEPS,
  SEQUENCEABLE_RUNNER_STEP_KINDS,
  buildRunnerSequenceCommand,
  parseRunnerSequenceResult,
  validateRunnerSequenceSteps,
  type RunnerSequenceStep,
} from '../runner-contract.ts';

function tap(x: number, y: number): RunnerSequenceStep {
  return { kind: 'tap', x, y };
}

test('SEQUENCEABLE_RUNNER_STEP_KINDS is the documented allowlist', () => {
  assert.deepEqual([...SEQUENCEABLE_RUNNER_STEP_KINDS], ['tap', 'doubleTap', 'longPress']);
});

test('validateRunnerSequenceSteps accepts doubleTap steps with finite coords', () => {
  assert.doesNotThrow(() =>
    validateRunnerSequenceSteps([{ kind: 'doubleTap', x: 10, y: 20, pauseMs: 50 }]),
  );
});

test('validateRunnerSequenceSteps rejects an unsupported kind naming the step index', () => {
  assert.throws(
    () =>
      validateRunnerSequenceSteps([
        tap(1, 2),
        { kind: 'pinch' as RunnerSequenceStep['kind'], x: 3, y: 4 },
      ]),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.match(error.message, /step 1/);
      assert.match(error.message, /pinch/);
      assert.equal(error.details?.stepIndex, 1);
      return true;
    },
  );
});

test('validateRunnerSequenceSteps rejects swipe (another non-allowlisted kind)', () => {
  assert.throws(
    () =>
      validateRunnerSequenceSteps([{ kind: 'swipe' as RunnerSequenceStep['kind'], x: 1, y: 2 }]),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );
});

test('validateRunnerSequenceSteps rejects empty step list', () => {
  assert.throws(
    () => validateRunnerSequenceSteps([]),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );
});

test('validateRunnerSequenceSteps enforces the step-count cap', () => {
  const steps = Array.from({ length: MAX_RUNNER_SEQUENCE_STEPS + 1 }, () => tap(1, 2));
  assert.throws(
    () => validateRunnerSequenceSteps(steps),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.equal(error.details?.maxSteps, MAX_RUNNER_SEQUENCE_STEPS);
      return true;
    },
  );
});

test('validateRunnerSequenceSteps accepts exactly the cap', () => {
  const steps = Array.from({ length: MAX_RUNNER_SEQUENCE_STEPS }, () => tap(1, 2));
  validateRunnerSequenceSteps(steps);
});

test('validateRunnerSequenceSteps requires finite x/y on every step', () => {
  assert.throws(
    () => validateRunnerSequenceSteps([{ kind: 'tap', x: Number.NaN, y: 2 }]),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );
});

test('validateRunnerSequenceSteps accepts a low durationMs (runner clamps the floor)', () => {
  // `press --hold-ms 5` is legal CLI input (holdMs min 0); the runner clamps durationMs up to 16,
  // so the validator must not reject a below-floor duration here.
  validateRunnerSequenceSteps([{ kind: 'longPress', x: 1, y: 2, durationMs: 5 }]);
  validateRunnerSequenceSteps([{ kind: 'longPress', x: 1, y: 2, durationMs: 0 }]);
});

test('validateRunnerSequenceSteps rejects out-of-range durationMs and pauseMs', () => {
  assert.throws(
    () => validateRunnerSequenceSteps([{ kind: 'longPress', x: 1, y: 2, durationMs: -1 }]),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );
  assert.throws(
    () => validateRunnerSequenceSteps([{ kind: 'longPress', x: 1, y: 2, durationMs: 20_000 }]),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );
  assert.throws(
    () => validateRunnerSequenceSteps([{ kind: 'tap', x: 1, y: 2, pauseMs: 20_000 }]),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );
});

test('buildRunnerSequenceCommand returns a validated sequence command', () => {
  const command = buildRunnerSequenceCommand([tap(10, 20)], 'com.example.app');
  assert.equal(command.command, 'sequence');
  assert.equal(command.appBundleId, 'com.example.app');
  assert.deepEqual(command.steps, [tap(10, 20)]);
});

test('parseRunnerSequenceResult returns ordered results when no step failed', () => {
  const parsed = parseRunnerSequenceResult({
    completedSteps: 2,
    sequenceResults: [
      { ok: true, kind: 'tap', gestureStartUptimeMs: 1, gestureEndUptimeMs: 2 },
      { ok: true, kind: 'longPress', gestureStartUptimeMs: 3, gestureEndUptimeMs: 4 },
    ],
  });
  assert.equal(parsed.completedSteps, 2);
  assert.equal(parsed.failedStepIndex, undefined);
  assert.equal(parsed.results.length, 2);
  assert.equal(parsed.results[0]?.kind, 'tap');
  assert.equal(parsed.results[1]?.kind, 'longPress');
});

test('parseRunnerSequenceResult maps failedStepIndex to a deterministic AppError', () => {
  assert.throws(
    () =>
      parseRunnerSequenceResult({
        completedSteps: 2,
        failedStepIndex: 2,
        sequenceResults: [
          { ok: true, kind: 'tap' },
          { ok: true, kind: 'tap' },
          {
            ok: false,
            kind: 'longPress',
            errorCode: 'UNSUPPORTED_OPERATION',
            errorMessage: 'long press unsupported here',
          },
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'UNSUPPORTED_OPERATION');
      assert.equal(error.message, 'long press unsupported here');
      assert.equal(error.details?.failedStepIndex, 2);
      assert.equal(error.details?.failedStepKind, 'longPress');
      assert.equal(error.details?.completedSteps, 2);
      assert.ok(Array.isArray(error.details?.sequenceResults));
      return true;
    },
  );
});

test('parseRunnerSequenceResult surfaces the failing step hint', () => {
  assert.throws(
    () =>
      parseRunnerSequenceResult({
        completedSteps: 0,
        failedStepIndex: 0,
        sequenceResults: [
          {
            ok: false,
            kind: 'doubleTap',
            errorCode: 'UNSUPPORTED_OPERATION',
            errorMessage: 'XCTest cannot anchor a coordinate gesture',
            errorHint: 'The runner dispatched nothing.',
          },
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.hint, 'The runner dispatched nothing.');
      return true;
    },
  );
});

test('parseRunnerSequenceResult infers a failure from sequenceResults when failedStepIndex is absent', () => {
  assert.throws(
    () =>
      parseRunnerSequenceResult({
        sequenceResults: [
          { ok: true, kind: 'tap' },
          { ok: false, kind: 'tap', errorCode: 'COMMAND_FAILED', errorMessage: 'boom' },
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.failedStepIndex, 1);
      return true;
    },
  );
});

test('a sequence step that failed after hand-off reads like the standalone command', () => {
  assert.throws(
    () =>
      parseRunnerSequenceResult({
        sequenceResults: [
          {
            ok: false,
            kind: 'longPress',
            errorCode: 'SYNTHESIZED_GESTURE_OUTCOME_UNKNOWN',
            errorMessage: 'synthesis failed',
          },
        ],
        completedSteps: 0,
        failedStepIndex: 0,
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.runnerErrorCode, 'SYNTHESIZED_GESTURE_OUTCOME_UNKNOWN');
      assert.equal(error.details?.reason, 'synthesized_gesture_outcome_unknown');
      assert.equal(error.details?.dispatched, 'unknown');
      return true;
    },
  );
});

function sequenceFailure(results: Array<Record<string, unknown>>): AppError {
  const failedStepIndex = results.findIndex((result) => result.ok !== true);
  try {
    parseRunnerSequenceResult({
      sequenceResults: results,
      completedSteps: failedStepIndex,
      failedStepIndex,
    });
  } catch (error) {
    assert.ok(error instanceof AppError);
    return error;
  }
  throw new Error('expected a sequence failure');
}

const notDispatchedLongPress = {
  ok: false,
  kind: 'longPress',
  errorCode: 'SYNTHESIZED_GESTURE_NOT_DISPATCHED',
  errorMessage: 'synthesis refused',
};

test('a first step refused before dispatch means the sequence sent nothing', () => {
  const error = sequenceFailure([notDispatchedLongPress]);
  assert.equal(error.code, 'COMMAND_FAILED');
  assert.equal(error.details?.runnerErrorCode, 'SYNTHESIZED_GESTURE_NOT_DISPATCHED');
  assert.equal(error.details?.dispatched, 'no');
});

test('a step refused before dispatch after an earlier step ran leaves the sequence unknown', () => {
  const error = sequenceFailure([{ ok: true, kind: 'tap' }, notDispatchedLongPress]);
  assert.equal(error.details?.runnerErrorCode, 'SYNTHESIZED_GESTURE_NOT_DISPATCHED');
  assert.equal(error.details?.dispatched, 'unknown');
});
