import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { runApplePressSeries } from '../runner-sequence.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import type { RunnerCommand } from '../runner-contract.ts';

test.each([
  { boundary: 'step cap', count: 21, intervalMs: 0, completed: 20 },
  { boundary: 'time budget', count: 3, intervalMs: 10_000, completed: 1 },
])(
  'an orientation change at the $boundary stops the next chunk',
  async ({ count, intervalMs, completed }) => {
    let orientation = 1;
    let dispatched = 0;
    const requests: RunnerCommand[] = [];
    await assert.rejects(
      runApplePressSeries(
        IOS_SIMULATOR,
        { x: 10, y: 20 },
        { button: 'primary', count, intervalMs, holdMs: 0, jitterPx: 0, doubleTap: false },
        undefined,
        async (command) => {
          requests.push(command);
          const bound = command.sequenceOrientation ?? orientation;
          const results = [];
          let completedSteps = 0;
          for (const step of command.steps ?? []) {
            if (bound !== orientation) {
              results.push({ ok: false, kind: step.kind, errorCode: 'UNSUPPORTED_OPERATION' });
              return {
                sequenceOrientation: bound,
                completedSteps,
                failedStepIndex: completedSteps,
                sequenceResults: results,
              };
            }
            dispatched += 1;
            completedSteps += 1;
            results.push({ ok: true, kind: step.kind });
            if (dispatched === completed) orientation = 3;
          }
          return { sequenceOrientation: bound, completedSteps, sequenceResults: results };
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'UNSUPPORTED_OPERATION');
        assert.equal(error.details?.failedStepIndex, completed);
        assert.equal(error.details?.completedSteps, completed);
        assert.equal(error.details?.dispatched, 'unknown');
        assert.equal(error.details?.dispatchedSteps, completed);
        return true;
      },
    );
    assert.equal(dispatched, completed);
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.steps?.length, completed);
    assert.equal(requests[1]?.sequenceOrientation, 1);
  },
);

test.each([undefined, 0, 5, 1.5, '1'])(
  'a missing or invalid first-chunk orientation (%s) cannot authorize another chunk',
  async (sequenceOrientation) => {
    let requests = 0;
    await assert.rejects(
      runApplePressSeries(
        IOS_SIMULATOR,
        { x: 10, y: 20 },
        { button: 'primary', count: 21, intervalMs: 0, holdMs: 0, jitterPx: 0, doubleTap: false },
        undefined,
        async (command) => {
          requests += 1;
          return {
            sequenceOrientation,
            completedSteps: command.steps!.length,
            sequenceResults: command.steps!.map(({ kind }) => ({ ok: true, kind })),
          };
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.reason, 'runner_sequence_orientation_unavailable');
        assert.equal(error.details?.dispatchedSteps, 20);
        return true;
      },
    );
    assert.equal(requests, 1);
  },
);

test('a step failure in a later chunk counts the taps every chunk completed', async () => {
  const ok = (count: number) => Array.from({ length: count }, () => ({ ok: true, kind: 'tap' }));
  const answers = [
    { sequenceOrientation: 1, completedSteps: 20, sequenceResults: ok(20) },
    { completedSteps: 2, sequenceResults: [...ok(2), { ok: false, kind: 'tap' }] },
  ];
  await assert.rejects(
    runApplePressSeries(
      IOS_SIMULATOR,
      { x: 10, y: 20 },
      { button: 'primary', count: 25, intervalMs: 0, holdMs: 0, jitterPx: 0, doubleTap: false },
      undefined,
      async () => answers.shift()!,
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.failedStepIndex, 22);
      assert.equal(error.details?.dispatched, 'unknown');
      assert.equal(error.details?.dispatchedSteps, 22);
      return true;
    },
  );
});

test('a long-press step refused before dispatch after an earlier step ran leaves the series unknown', async () => {
  let sends = 0;
  await assert.rejects(
    runApplePressSeries(
      IOS_SIMULATOR,
      { x: 10, y: 20 },
      { button: 'primary', count: 2, intervalMs: 0, holdMs: 600, jitterPx: 0, doubleTap: false },
      undefined,
      async () => {
        sends += 1;
        return {
          sequenceOrientation: 1,
          completedSteps: 1,
          failedStepIndex: 1,
          sequenceResults: [
            { ok: true, kind: 'longPress' },
            { ok: false, kind: 'longPress', errorCode: 'SYNTHESIZED_GESTURE_NOT_DISPATCHED' },
          ],
        };
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.runnerErrorCode, 'SYNTHESIZED_GESTURE_NOT_DISPATCHED');
      assert.equal(error.details?.dispatched, 'unknown');
      assert.equal(error.details?.dispatchedSteps, 1);
      return true;
    },
  );
  assert.equal(sends, 1, 'the refused step is not resent');
});
