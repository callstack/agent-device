import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { runScrollEdgePasses, runScrollPasses } from '../scroll-edge-state.ts';

type Frame = { readable: boolean; done: boolean; fingerprint?: string };

const REFUSED = new AppError('COMMAND_FAILED', 'refused', { reason: 'refused' });
const PASS_LIMIT = new AppError('COMMAND_FAILED', 'limit', { reason: 'limit' });
const NO_PROGRESS = new AppError('COMMAND_FAILED', 'stuck', { reason: 'stuck' });

/** Drives the shared loop over scripted frames, counting what it asked for. */
async function run(frames: Frame[], passLimit = 10) {
  const calls = { observe: 0, shouldStop: 0, scroll: 0, settle: 0 };
  const outcome = runScrollPasses({
    observe: async () => frames[Math.min(calls.observe++, frames.length - 1)]!,
    refuse: (frame) => (frame.readable ? undefined : REFUSED),
    shouldStop: async (frame) => {
      calls.shouldStop += 1;
      return frame.done;
    },
    passLimit,
    passLimitError: () => PASS_LIMIT,
    fingerprint: async (frame) => frame.fingerprint,
    noProgressError: () => NO_PROGRESS,
    scroll: async () => ({ pass: ++calls.scroll }),
    settleAfterPass: async () => {
      calls.settle += 1;
    },
  });
  return { outcome, calls };
}

test('runScrollPasses: a stop on the first observation costs no gesture', async () => {
  const { outcome, calls } = await run([{ readable: true, done: true }]);
  assert.deepEqual(await outcome, { passes: 0, result: undefined });
  assert.equal(calls.scroll, 0);
});

test('runScrollPasses: scrolls and settles once per pass and reports the last gesture', async () => {
  const { outcome, calls } = await run([
    { readable: true, done: false, fingerprint: 'a' },
    { readable: true, done: false, fingerprint: 'b' },
    { readable: true, done: true },
  ]);
  assert.deepEqual(await outcome, { passes: 2, result: { pass: 2 } });
  assert.equal(calls.settle, 2);
});

test('runScrollPasses: refuses an unreadable observation before asking the stop condition', async () => {
  const { outcome, calls } = await run([{ readable: false, done: true }]);
  await assert.rejects(outcome, (error) => error === REFUSED);
  assert.equal(calls.shouldStop, 0);
  assert.equal(calls.scroll, 0);
});

test('runScrollPasses: refuses an observation that goes unreadable after a pass', async () => {
  const { outcome, calls } = await run([
    { readable: true, done: false, fingerprint: 'a' },
    { readable: false, done: true },
  ]);
  await assert.rejects(outcome, (error) => error === REFUSED);
  assert.equal(calls.scroll, 1);
});

test('runScrollPasses: spends exactly its pass budget, then raises the caller error', async () => {
  const budget = 3;
  const frames = Array.from({ length: budget + 1 }, (_, index) => ({
    readable: true,
    done: false,
    fingerprint: `f${index}`,
  }));
  const { outcome, calls } = await run(frames, budget);
  await assert.rejects(outcome, (error) => error === PASS_LIMIT);
  assert.equal(calls.scroll, budget);
});

/**
 * The budget is checked before the stuck window, so an explicit small budget reports the budget
 * rather than no-progress (the order `scroll --until` documented before the loops were shared).
 */
test('runScrollPasses: a surface that never shifts stops as no-progress, the budget winning ties', async () => {
  const stuck = { readable: true, done: false, fingerprint: 'same' };
  const unbounded = await run([stuck], 10);
  await assert.rejects(unbounded.outcome, (error) => error === NO_PROGRESS);
  assert.equal(unbounded.calls.scroll, 3);

  const bounded = await run([stuck], 3);
  await assert.rejects(bounded.outcome, (error) => error === PASS_LIMIT);
});

test('runScrollPasses: an observation without a fingerprint never trips no-progress', async () => {
  const { outcome, calls } = await run([{ readable: true, done: false }], 5);
  await assert.rejects(outcome, (error) => error === PASS_LIMIT);
  assert.equal(calls.scroll, 5);
});

test('runScrollEdgePasses: a refused capture raises the typed edge refusal before any gesture', async () => {
  let scrolls = 0;
  await assert.rejects(
    runScrollEdgePasses({
      edge: 'bottom',
      captureState: async () => ({
        refused: { reason: 'sparse-tree', detail: 'AX bridge unavailable' },
      }),
      scroll: async () => {
        scrolls += 1;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.reason, 'scroll_edge_capture_unreadable');
      assert.equal(error.details?.edge, 'bottom');
      assert.equal(error.details?.captureRefusal, 'sparse-tree');
      assert.match(error.message, /AX bridge unavailable/);
      return true;
    },
  );
  assert.equal(scrolls, 0);
});
