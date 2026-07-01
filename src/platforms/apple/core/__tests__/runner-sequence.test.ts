import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '../../../../kernel/errors.ts';
import {
  MAX_RUNNER_SEQUENCE_STEPS,
  SEQUENCEABLE_RUNNER_STEP_KINDS,
  buildRunnerSequenceCommand,
  parseRunnerSequenceResult,
  validateRunnerSequenceSteps,
} from '../runner/runner-sequence.ts';
import type { RunnerSequenceStep } from '../runner/runner-contract.ts';

function tap(x: number, y: number): RunnerSequenceStep {
  return { kind: 'tap', x, y };
}

test('SEQUENCEABLE_RUNNER_STEP_KINDS is the documented allowlist', () => {
  assert.deepEqual([...SEQUENCEABLE_RUNNER_STEP_KINDS], ['tap', 'doubleTap', 'longPress', 'drag']);
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

test('validateRunnerSequenceSteps requires x2/y2 for drag steps', () => {
  assert.throws(
    () => validateRunnerSequenceSteps([tap(1, 2), { kind: 'drag', x: 3, y: 4 }]),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.match(error.message, /step 1/);
      assert.match(error.message, /drag/);
      return true;
    },
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
            kind: 'drag',
            errorCode: 'UNSUPPORTED_OPERATION',
            errorMessage: 'drag unsupported here',
          },
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'UNSUPPORTED_OPERATION');
      assert.equal(error.message, 'drag unsupported here');
      assert.equal(error.details?.failedStepIndex, 2);
      assert.equal(error.details?.failedStepKind, 'drag');
      assert.equal(error.details?.completedSteps, 2);
      assert.ok(Array.isArray(error.details?.sequenceResults));
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
