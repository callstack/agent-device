import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { buildSnapshotState } from '@agent-device/capture-kit/snapshot-state';
import { AppError } from '@agent-device/kernel/errors';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { resolveScrollRuntimePlan } from '@agent-device/contracts/platform-runtime-operations';
import { ANDROID_TV_DEVICE, IPADOS_SIMULATOR } from '@agent-device/test-kit';
import { makeAndroidSession } from '../../__tests__/support/session-factories.ts';
import { activateCompleteRefFrame } from '../../core/ref-frame.ts';
import { runScroll } from './scroll-runtime.test.ts';
import {
  automationScreen,
  frozenCaptures,
  SCREEN_CONTAINER,
  sessionWithStoredScreen,
} from './scroll-runtime-fixtures.ts';

/**
 * `scroll refresh`: one slow downward pan anchored just inside the top of the resolved scroll
 * container, planned in TypeScript and dispatched through the bound gesture pan operation. The
 * refusal cases name typed reasons (never text to match): not-at-top when the tree still hides
 * content above, no container when the surface names no scroller, and an admission refusal on
 * the platform's touch-scroll-surface fact where there is no touch scroll (a TV target, a
 * desktop leaf).
 */
function topScreen(hiddenAbove: boolean): SnapshotNode[] {
  return automationScreen(0, false).map((node) =>
    node.type === 'ScrollView'
      ? { ...node, ...(hiddenAbove ? { hiddenContentAbove: true } : {}) }
      : node,
  );
}

/** The pan plan one pull dispatches, as the bound gesture operation receives it. */
type PullPlanCall = {
  intent: string;
  topology: string;
  durationMs: number;
  viewport: { x: number; y: number; width: number; height: number };
  pointers: Array<{
    pointerId: number;
    samples: Array<{ offsetMs: number; point: { x: number; y: number } }>;
  }>;
};

function pullSamples(plan: PullPlanCall) {
  return plan.pointers[0]!.samples;
}

test('scroll refresh resolves to the refresh plan on the touch-surface use', () => {
  const plan = resolveScrollRuntimePlan({ refresh: true });
  expect(plan.kind).toBe('refresh');
  expect([...plan.use.required]).toEqual([
    'touchScrollSurface',
    'performGesturePlan',
    'captureSnapshot',
  ]);
});

test('bound scroll refresh refuses with scroll_refresh_not_at_top while content is hidden above', async () => {
  const plans: PullPlanCall[] = [];
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
          scroll: async () => {
            throw new Error('refresh must not reach the scroll owner');
          },
          gesture: async (plan) => {
            plans.push(plan as PullPlanCall);
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
  assert.equal(plans.length, 0, 'no pull is dispatched when the list is not at the top');
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
        {
          ...frozenCaptures([plainScreen]),
          scroll: async () => ({}),
          gesture: async () => {
            throw new Error('refresh must not dispatch a pull without a container');
          },
        },
        { session: sessionWithStoredScreen(plainScreen) },
      ),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'scroll_refresh_no_container',
  );
});

test('bound scroll refresh refuses at admission where the platform declares no touch scroll surface', async () => {
  // The daemon holds no inline platform check: the platform runtime's touch-scroll-surface fact
  // is what admission reads, so a TV target or a desktop leaf refuses with the typed reason
  // before any capture or gesture.
  const tvSession = makeAndroidSession('scroll-refresh-tv', { device: ANDROID_TV_DEVICE });
  tvSession.snapshot = buildSnapshotState(
    { nodes: topScreen(false), backend: 'android', producer: 'android-uiautomator' },
    undefined,
  );
  activateCompleteRefFrame(tvSession);
  await assert.rejects(
    () =>
      runScroll(
        ['refresh'],
        {},
        { scroll: async () => ({}), touchScrollSurface: false },
        { session: tvSession },
      ),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'UNSUPPORTED_OPERATION' &&
      error.details?.reason === 'scroll_refresh_unsupported_platform',
  );
});

test('bound scroll refresh admits on iPadOS and dispatches the pull there', async () => {
  const plans: PullPlanCall[] = [];
  const session = sessionWithStoredScreen(topScreen(false), {
    device: IPADOS_SIMULATOR,
  });
  const result = await runScroll(
    ['refresh'],
    {},
    {
      ...frozenCaptures([topScreen(false), topScreen(false), topScreen(false)]),
      scroll: async () => {
        throw new Error('the pull dispatches through the gesture pan, not the scroll owner');
      },
      gesture: async (plan) => {
        plans.push(plan as PullPlanCall);
        return {};
      },
    },
    { session },
  );
  assert.equal(plans.length, 1, 'iPadOS declares a touch scroll surface, so the pull runs');
  assert.equal(result.refresh, true);
  assert.notEqual(result.movement, 'at-edge');
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

test('bound scroll refresh plans one slow top-anchored pan and never reports at-edge', async () => {
  const plans: PullPlanCall[] = [];
  // One frame answers the pre-pull top-edge read, then two quiet ones let the movement claim prove
  // the surface held still.
  const captures = frozenCaptures([topScreen(false), topScreen(false), topScreen(false)]);
  const result = await runScroll(
    ['refresh'],
    {},
    {
      ...captures,
      scroll: async () => {
        throw new Error('the pull dispatches through the gesture pan, not the scroll owner');
      },
      gesture: async (plan) => {
        plans.push(plan as PullPlanCall);
        return {};
      },
    },
    { session: sessionWithStoredScreen(topScreen(false)) },
  );

  assert.equal(plans.length, 1);
  const plan = plans[0]!;
  assert.equal(plan.intent, 'pan');
  assert.equal(plan.topology, 'single');
  assert.equal(plan.durationMs, 1200, 'the pull is slow: a fast pull reads as a fling');
  // The lane starts just inside the top of the container (padded band), at the container's
  // centre cross-axis, and drags down by the clamped pull distance.
  const samples = pullSamples(plan);
  assert.equal(samples.length, 2, 'a plain timed pan: no hold sample is appended');
  assert.deepEqual(samples[0], { offsetMs: 0, point: { x: 201, y: 186 } });
  assert.deepEqual(samples[1], { offsetMs: 1200, point: { x: 201, y: 506 } });

  assert.equal(result.refresh, true);
  assert.equal(result.direction, 'up');
  assert.equal(
    result.pixels,
    320,
    'default pull: 0.4 of the 662px container = 265px, clamped up to the floor',
  );
  assert.equal(result.movement, 'unchanged', 'a refresh pull never answers at-edge');
  assert.match(String(result.message), /Pulled to refresh at the top edge/);
});

test('bound scroll refresh honors an explicit amount as the pull fraction of the container', async () => {
  const plans: PullPlanCall[] = [];
  await runScroll(
    ['refresh', '0.8'],
    {},
    {
      ...frozenCaptures([topScreen(false)]),
      scroll: async () => ({}),
      gesture: async (plan) => {
        plans.push(plan as PullPlanCall);
        return {};
      },
    },
    { session: sessionWithStoredScreen(topScreen(false)) },
  );
  // 0.8 of 662px = 530px, clamped down to the pull ceiling.
  assert.deepEqual(pullSamples(plans[0]!).at(-1)!.point, { x: 201, y: 186 + 520 });
});

test('bound scroll refresh clamps an explicit --pixels into the measured-safe pull band', async () => {
  const plans: PullPlanCall[] = [];
  await runScroll(
    ['refresh'],
    { pixels: 100 },
    {
      ...frozenCaptures([topScreen(false)]),
      scroll: async () => ({}),
      gesture: async (plan) => {
        plans.push(plan as PullPlanCall);
        return {};
      },
    },
    { session: sessionWithStoredScreen(topScreen(false)) },
  );
  assert.equal(
    pullSamples(plans[0]!).at(-1)!.point.y - pullSamples(plans[0]!)[0]!.point.y,
    320,
    'a 100px pull only rubber-bands; the floor is 320px',
  );
});

test('bound scroll refresh refuses an unreadable capture with its own typed reason, not no_container', async () => {
  await assert.rejects(
    () =>
      runScroll(
        ['refresh'],
        {},
        {
          ...frozenCaptures([[]]),
          scroll: async () => ({}),
          gesture: async () => ({}),
        },
        { session: sessionWithStoredScreen(topScreen(false)) },
      ),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'scroll_refresh_capture_unreadable',
  );
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
  const plans: PullPlanCall[] = [];
  await runScroll(
    ['refresh'],
    {},
    {
      ...frozenCaptures([nestedScreen]),
      scroll: async () => ({}),
      gesture: async (plan) => {
        plans.push(plan as PullPlanCall);
        return {};
      },
    },
    { session: sessionWithStoredScreen(nestedScreen) },
  );
  const plan = plans[0]!;
  // The lane starts inside the INNER container's padded band: cross = 63 + 954/2 = 540,
  // y1 = 451 + 8 (inset) = 459 within the padded viewport.
  assert.deepEqual(pullSamples(plan)[0]!.point, { x: 540, y: 459 });
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
  const plans: PullPlanCall[] = [];
  await assert.rejects(
    () =>
      runScroll(
        ['refresh'],
        {},
        {
          ...frozenCaptures([nestedScrolled]),
          scroll: async () => ({}),
          gesture: async (plan) => {
            plans.push(plan as PullPlanCall);
            return {};
          },
        },
        { session: sessionWithStoredScreen(nestedScrolled) },
      ),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'scroll_refresh_not_at_top',
  );
  assert.equal(plans.length, 0);
});
