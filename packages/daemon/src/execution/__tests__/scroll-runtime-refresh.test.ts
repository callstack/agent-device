import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { buildSnapshotState } from '@agent-device/capture-kit/snapshot-state';
import { AppError } from '@agent-device/kernel/errors';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { resolveScrollRuntimePlan } from '@agent-device/contracts/platform-runtime-operations';
import { makeMacOsSession } from '../../__tests__/support/session-factories.ts';
import { activateCompleteRefFrame } from '../../core/ref-frame.ts';
import {
  automationScreen,
  frozenCaptures,
  runScroll,
  SCREEN_CONTAINER,
  sessionWithStoredScreen,
  type ScrollCall,
} from './scroll-runtime.test.ts';

/**
 * `scroll refresh`: one pull anchored at the container's top edge. The refusal cases name typed
 * reasons (never text to match): not-at-top when the tree still hides content above, no container
 * when the surface names no scroller, and unsupported platform where there is no touch scroll.
 */
function topScreen(hiddenAbove: boolean): SnapshotNode[] {
  return automationScreen(0, false).map((node) =>
    node.type === 'ScrollView'
      ? { ...node, ...(hiddenAbove ? { hiddenContentAbove: true } : {}) }
      : node,
  );
}

test('scroll refresh resolves to the refresh plan on the verified-pass use', () => {
  const plan = resolveScrollRuntimePlan({ refresh: true });
  expect(plan.kind).toBe('refresh');
  expect([...plan.use.required]).toEqual(['scrollDirection', 'captureSnapshot']);
});

test('bound scroll refresh refuses with scroll_refresh_not_at_top while content is hidden above', async () => {
  const calls: ScrollCall[] = [];
  await assert.rejects(
    () =>
      runScroll(
        ['refresh'],
        {},
        {
          // The refusal reads a fresh capture inside the executor, so the stored tree being
          // current is not what answers — the captured one is, even after an earlier gesture
          // expired the stored ref frame (ADR 0014).
          ...frozenCaptures([topScreen(true)]),
          scroll: async (direction, options) => {
            calls.push({ direction, options });
            return {};
          },
        },
        { session: sessionWithStoredScreen(topScreen(false)) },
      ),
    (error: unknown) => {
      if (!(error instanceof AppError)) return false;
      if (error.details?.reason !== 'scroll_refresh_not_at_top') return false;
      assert.deepEqual(error.details?.containerRect, SCREEN_CONTAINER);
      return true;
    },
  );
  assert.equal(calls.length, 0, 'no pull is dispatched when the list is not at the top');
});

test('bound scroll refresh refuses with scroll_refresh_no_container when no scroller is named', async () => {
  const plainScreen: SnapshotNode[] = [
    {
      ref: 'e1',
      index: 1,
      depth: 0,
      type: 'Other',
      label: 'Plain surface',
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
  ];
  await assert.rejects(
    () =>
      runScroll(
        ['refresh'],
        {},
        { ...frozenCaptures([plainScreen]), scroll: async () => ({}) },
        { session: sessionWithStoredScreen(plainScreen) },
      ),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'scroll_refresh_no_container',
  );
});

test('bound scroll refresh refuses on a platform without a touch scroll surface', async () => {
  const session = makeMacOsSession('scroll-refresh-desktop');
  session.snapshot = buildSnapshotState(
    { nodes: topScreen(false), backend: 'xctest', producer: 'apple-runner' },
    undefined,
  );
  activateCompleteRefFrame(session);
  await assert.rejects(
    () => runScroll(['refresh'], {}, { scroll: async () => ({}) }, { session }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'UNSUPPORTED_OPERATION' &&
      error.details?.reason === 'scroll_refresh_unsupported_platform',
  );
});

test('bound scroll refresh refuses --until with a typed reason before any device work', async () => {
  await assert.rejects(
    () =>
      runScroll(
        ['refresh'],
        { until: 'id="row-9"' },
        {
          scroll: async () => {
            throw new Error('refresh with --until must be rejected before the owner is reached');
          },
        },
      ),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.details?.reason === 'scroll_refresh_until_unsupported',
  );
});

test('bound scroll refresh pulls once from the container top with a hold and never reports at-edge', async () => {
  const calls: ScrollCall[] = [];
  // One frame answers the pre-pull top-edge read, then two quiet ones let the movement claim prove
  // the surface held still.
  const captures = frozenCaptures([topScreen(false), topScreen(false), topScreen(false)]);
  const result = await runScroll(
    ['refresh'],
    {},
    {
      ...captures,
      scroll: async (direction, options) => {
        calls.push({ direction, options });
        return { x1: 201, y1: 186, x2: 201, y2: 506, pixels: 320, durationMs: 1200 };
      },
    },
    { session: sessionWithStoredScreen(topScreen(false)) },
  );

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.direction, 'up', 'the pull is an up scroll (finger drags down)');
  const options = call.options as Record<string, unknown>;
  assert.equal(options.anchorTop, true);
  assert.equal(options.holdMs, 400);
  assert.equal(options.releaseBehavior, 'controlled');
  assert.equal(options.durationMs, 1200);
  assert.deepEqual(options.containerRect, SCREEN_CONTAINER);
  // Default pull: 0.4 of the 662px container = 265px, clamped up into the measured-safe band.
  assert.equal(options.pixels, 320);

  assert.equal(result.refresh, true);
  assert.equal(result.direction, 'up');
  assert.equal(result.movement, 'unchanged', 'a refresh pull never answers at-edge');
  assert.match(String(result.message), /Pulled to refresh at the top edge/);
});

test('bound scroll refresh honors an explicit amount as the pull fraction of the container', async () => {
  const calls: ScrollCall[] = [];
  await runScroll(
    ['refresh', '0.8'],
    {},
    {
      ...frozenCaptures([topScreen(false)]),
      scroll: async (direction, options) => {
        calls.push({ direction, options });
        return { pixels: 520 };
      },
    },
    { session: sessionWithStoredScreen(topScreen(false)) },
  );
  const options = calls[0]!.options as Record<string, unknown>;
  assert.equal(options.amount, 0.8);
  // 0.8 of 662px = 530px, clamped down to the pull ceiling.
  assert.equal(options.pixels, 520);
});

test('bound scroll refresh anchors the pull inside the innermost nested scroller, not the screen-level one', async () => {
  // A list nested in a screen-level ScrollView: the broad top-edge read names the outer scroller,
  // but a pull anchored there starts on the header and moves nothing.
  const innerRect = { x: 63, y: 451, width: 954, height: 1823 };
  const nestedScreen: SnapshotNode[] = [
    {
      ref: 'e1',
      index: 1,
      depth: 0,
      type: 'ScrollView',
      rect: { x: 0, y: 132, width: 1080, height: 2142 },
    },
    {
      ref: 'e2',
      index: 2,
      parentIndex: 1,
      depth: 1,
      type: 'ScrollView',
      identifier: 'refresh-list',
      rect: innerRect,
      hiddenContentBelow: true,
    },
  ];
  const calls: ScrollCall[] = [];
  await runScroll(
    ['refresh'],
    {},
    {
      ...frozenCaptures([nestedScreen]),
      scroll: async (direction, options) => {
        calls.push({ direction, options });
        return { pixels: 520 };
      },
    },
    { session: sessionWithStoredScreen(nestedScreen) },
  );
  const options = calls[0]!.options as Record<string, unknown>;
  assert.deepEqual(options.containerRect, innerRect);
});

test('bound scroll refresh refuses when a nested scroller still hides content above even if the outer one is at the top', async () => {
  const nestedScrolled: SnapshotNode[] = [
    {
      ref: 'e1',
      index: 1,
      depth: 0,
      type: 'ScrollView',
      rect: { x: 0, y: 132, width: 1080, height: 2142 },
    },
    {
      ref: 'e2',
      index: 2,
      parentIndex: 1,
      depth: 1,
      type: 'ScrollView',
      identifier: 'refresh-list',
      rect: { x: 63, y: 451, width: 954, height: 1823 },
      hiddenContentAbove: true,
      hiddenContentBelow: true,
    },
  ];
  const calls: ScrollCall[] = [];
  await assert.rejects(
    () =>
      runScroll(
        ['refresh'],
        {},
        {
          ...frozenCaptures([nestedScrolled]),
          scroll: async (direction, options) => {
            calls.push({ direction, options });
            return {};
          },
        },
        { session: sessionWithStoredScreen(nestedScrolled) },
      ),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'scroll_refresh_not_at_top',
  );
  assert.equal(calls.length, 0);
});
