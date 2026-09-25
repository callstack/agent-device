import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { SnapshotResult } from '@agent-device/contracts/interactor-types';
import { buildSnapshotState } from '@agent-device/capture-kit/snapshot-state';
import { AppError } from '@agent-device/kernel/errors';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { IOS_SIMULATOR, MACOS_DEVICE } from '../../__tests__/test-utils/device-fixtures.ts';
import { makeSession } from '../../__tests__/test-utils/session-factories.ts';
import { expireRefFrame } from '../ref-frame.ts';
import {
  observeScrollMovement,
  planScrollMovement,
  readScrollSurfaceBaseline,
  reportScrollMovementNotApplicable,
  reportScrollMovementUnobserved,
  type ScrollMovementPlan,
  type ScrollSurfaceBaseline,
} from '../scroll-movement.ts';

// The reason a scroll withholds its claim lives in the daemon log, so the cases below pin it there
// rather than trusting a bare `unobserved`.
vi.mock('@agent-device/host-kit/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/diagnostics')>();
  return { ...actual, emitDiagnostic: vi.fn() };
});

const loggedDiagnostics = vi.mocked(emitDiagnostic);

function movementDiagnostic(): { phase: string; level: string; data: Record<string, unknown> } {
  const call = [...loggedDiagnostics.mock.calls]
    .reverse()
    .find(([event]) => String(event.phase).startsWith('scroll_movement_'));
  if (!call) throw new Error('the movement module logged no diagnostic');
  return {
    phase: call[0].phase,
    level: call[0].level ?? 'info',
    data: (call[0].data ?? {}) as Record<string, unknown>,
  };
}

function assertWithheld(reason: string): void {
  const entry = movementDiagnostic();
  assert.equal(entry.phase, 'scroll_movement_unobserved');
  assert.equal(entry.data.reason, reason);
}

function assertPlanKind<K extends ScrollMovementPlan['kind']>(
  plan: ScrollMovementPlan,
  kind: K,
): asserts plan is Extract<ScrollMovementPlan, { kind: K }> {
  if (plan.kind !== kind) throw new Error(`expected a "${kind}" plan, got "${plan.kind}"`);
}

/**
 * The observation that gates a directional scroll's distance claim (#2714). Node shapes follow the
 * live pair `interaction-surface-baseline-evidence.test.ts` transcribed: a scroller holding labelled
 * rows, plus fixed chrome that never moves.
 *
 * Every verdict here is paired with the closest input that must NOT produce it, because the whole
 * risk of this rule is failing a scroll that was fine: a no-op and a scroll at the end of its list
 * differ by one hidden-content hint, a no-op and a scroll over a busy screen differ by whether the
 * surface will hold still, and a no-op and a scroll whose content was replaced differ by the strict
 * no-effect bar rather than by the distance it names.
 */

const CONTAINER: Rect = { x: 18, y: 178, width: 366, height: 662 };
const SWIPE_MIDPOINT = { x: 201, y: 437 };
const REQUESTED_PIXELS = 656;

/** The trees one case feeds the observer: a fixed list of them, or one that never repeats. */
type SnapshotFrames = SnapshotNode[][] | ((attempt: number) => SnapshotNode[] | Error);

function screen(rowOffset: number, hiddenBelow = true): SnapshotNode[] {
  return [
    {
      type: 'ScrollView',
      identifier: 'lab-list',
      rect: CONTAINER,
      ...(hiddenBelow ? { hiddenContentBelow: true } : {}),
    },
    {
      type: 'StaticText',
      label: 'Row one',
      rect: { x: 24, y: 200 + rowOffset, width: 300, height: 20 },
    },
    {
      type: 'StaticText',
      label: 'Row two',
      rect: { x: 24, y: 260 + rowOffset, width: 300, height: 20 },
    },
    {
      type: 'Button',
      identifier: 'automation-press',
      label: 'Press canary',
      rect: { x: 24, y: 780, width: 200, height: 44 },
    },
  ] as SnapshotNode[];
}

function state(nodes: SnapshotNode[], flags?: Partial<CommandFlags>) {
  return buildSnapshotState({ nodes, backend: 'xctest', producer: 'apple-runner' }, flags);
}

function baselineOf(nodes: SnapshotNode[], flags?: Partial<CommandFlags>): ScrollSurfaceBaseline {
  const baseline = readScrollSurfaceBaseline(state(nodes, flags));
  if (!baseline) throw new Error('the fixture produced no comparable surface');
  return baseline;
}

/**
 * The captures the observation is allowed to take. A case that under-provides frames fails loudly:
 * reusing the last frame would let a quiet pair form by accident, turning a budget case into a
 * no-op case that passes for the wrong reason.
 */
function captures(screens: SnapshotFrames): {
  calls: () => number;
  capture: () => Promise<SnapshotResult>;
} {
  const next: (attempt: number) => SnapshotNode[] | Error =
    typeof screens === 'function' ? screens : queueReader(screens);
  let calls = 0;
  return {
    calls: () => calls,
    capture: async (): Promise<SnapshotResult> => {
      const frame = next(calls);
      calls += 1;
      if (frame instanceof Error) throw frame;
      return { nodes: frame, backend: 'xctest', producer: 'apple-runner' };
    },
  };
}

function queueReader(frames: SnapshotNode[][]) {
  return (attempt: number): SnapshotNode[] => {
    const frame = frames[attempt];
    if (frame === undefined) {
      throw new Error('the observation captured more times than the case supplied frames for');
    }
    return frame;
  };
}

function observe(params: {
  direction?: 'up' | 'down' | 'left' | 'right';
  baseline: ScrollSurfaceBaseline;
  screens: SnapshotFrames;
  midpoint?: { x: number; y: number };
  pixels?: number;
  budgetMs?: number;
}) {
  const spy = captures(params.screens);
  loggedDiagnostics.mockClear();
  const observation = observeScrollMovement({
    direction: params.direction ?? 'down',
    baseline: params.baseline,
    swipe: {
      midpoint: params.midpoint ?? SWIPE_MIDPOINT,
      pixels: params.pixels ?? REQUESTED_PIXELS,
    },
    capture: spy.capture,
    pollMs: 1,
    budgetMs: params.budgetMs ?? 5_000,
  });
  return { observation, spy };
}

test('a surface that no longer holds the pre-gesture content answers moved on the first capture', async () => {
  const { observation, spy } = observe({
    baseline: baselineOf(screen(0)),
    screens: [screen(-300)],
  });

  assert.equal(await observation, 'moved');
  // The cost claim of the whole feature: a scroll that worked is confirmed by one capture.
  assert.equal(spy.calls(), 1);
});

/**
 * At the end of a list iOS rubber-bands past the edge: the first capture lands mid-bounce with every row
 * shifted, then the content springs back to exactly the pre-gesture tree (#2884). A baseline that already
 * showed the end of the content turns that first read into a question, not a verdict.
 */
test('a bounce past the edge that springs back is at-edge, not moved', async () => {
  const { observation, spy } = observe({
    baseline: baselineOf(screen(0, false)),
    screens: [screen(-14, false), screen(0, false), screen(0, false)],
  });

  assert.equal(await observation, 'at-edge');
  assert.equal(spy.calls(), 3);
});

test('content that changes at the edge and holds still is still moved', async () => {
  const { observation, spy } = observe({
    baseline: baselineOf(screen(0, false)),
    screens: [screen(-300, false), screen(-300, false)],
  });

  assert.equal(await observation, 'moved');
  // The rest requirement costs exactly the one extra read, and only at the edge.
  assert.equal(spy.calls(), 2);
});

test('a bounce that never settles at the edge spends the budget and answers unobserved', async () => {
  const { observation } = observe({
    baseline: baselineOf(screen(0, false)),
    screens: (attempt) => screen(attempt % 2 === 0 ? -14 : 0, false),
    budgetMs: 40,
  });

  assert.equal(await observation, 'unobserved');
  assertWithheld('surface-unsettled');
});

test('a surface that never shifted while the container still hides content refuses with a typed reason', async () => {
  const { observation, spy } = observe({
    baseline: baselineOf(screen(0)),
    screens: [screen(0), screen(0)],
  });

  await assert.rejects(
    () => observation,
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'COMMAND_FAILED' &&
      error.details?.reason === 'scroll_no_progress' &&
      error.details.direction === 'down' &&
      error.details.hiddenContentAt === 'bottom' &&
      error.details.requestedPixels === REQUESTED_PIXELS &&
      typeof error.details.hint === 'string' &&
      /swipe x1 y1 x2 y2/.test(error.details.hint),
  );
  // Refusing needs the surface at rest, which needs the second read.
  assert.equal(spy.calls(), 2);
});

/**
 * The refusal above names a raw drag because it knows where the swipe ran. An owner that reports no
 * coordinates (a tvOS scroll is a remote keypress) must not be told to swipe where it cannot.
 */
test('a refusal without gesture coordinates does not recommend a swipe', async () => {
  const spy = captures([screen(0), screen(0)]);

  await assert.rejects(
    () =>
      observeScrollMovement({
        direction: 'down',
        baseline: baselineOf(screen(0)),
        swipe: {},
        capture: spy.capture,
        pollMs: 1,
        budgetMs: 5_000,
      }),
    (error: unknown) =>
      error instanceof AppError && !/swipe x1 y1 x2 y2/.test(String(error.details?.hint)),
  );
});

test('a surface that never shifted with nothing left to reveal answers at-edge, not a refusal', async () => {
  const { observation } = observe({
    baseline: baselineOf(screen(0)),
    screens: [screen(0, false), screen(0, false)],
  });

  assert.equal(await observation, 'at-edge');
});

test('a tree that names no scroll container is not read as the end of the content', async () => {
  const rowsOnly = screen(0).filter((node) => node.type !== 'ScrollView');
  const { observation } = observe({
    baseline: baselineOf(rowsOnly),
    screens: [rowsOnly, rowsOnly],
  });

  assert.equal(await observation, 'unobserved');
  assertWithheld('no-scroll-container');
});

test('a container the gesture never ran inside is not blamed for the no-op', async () => {
  const { observation } = observe({
    baseline: baselineOf(screen(0)),
    screens: [screen(0), screen(0)],
    midpoint: { x: 201, y: 40 },
  });

  assert.equal(await observation, 'unobserved');
  assertWithheld('container-outside-swipe');
});

test('a horizontal scroll that moved nothing reports what it measured instead of refusing', async () => {
  const pager = [
    { type: 'ScrollView', identifier: 'pager', rect: CONTAINER, hiddenContentBelow: true },
    { type: 'StaticText', label: 'Page', rect: { x: 24, y: 400, width: 200, height: 20 } },
  ] as SnapshotNode[];
  const { observation } = observe({
    direction: 'left',
    baseline: baselineOf(pager),
    screens: [pager, pager],
  });

  assert.equal(await observation, 'unchanged');
});

/**
 * A pair from different capture lineages is not two views of one screen — the XCTest-channel fallback
 * swaps the producer mid-request (#1569) — so its difference is neither movement nor a no-op. The
 * frames here genuinely differ: the gate has to hold on the path that would otherwise answer `moved`,
 * not only on the quiet one.
 */
test('a capture lineage that changed mid-request withholds the claim, even as the frames differ', async () => {
  const baseline = readScrollSurfaceBaseline({
    ...state(screen(0)),
    comparisonKey: 'lineage-before',
  });
  if (!baseline) throw new Error('the fixture produced no comparable surface');
  const { observation, spy } = observe({
    baseline,
    screens: [screen(-300)],
  });

  assert.equal(await observation, 'unobserved');
  assertWithheld('capture-lineage-drift');
  assert.equal(spy.calls(), 1);
});

/** The same gate on the other lineage axis: `snapshot -i` stored the baseline, and the broad tree this
 * command reads shares too little with it to refuse a scroll on — or to credit one. */
test('a baseline captured interactively-only withholds the claim, even as the frames differ', async () => {
  const { observation } = observe({
    baseline: baselineOf(screen(0), { snapshotInteractiveOnly: true }),
    screens: [screen(-300)],
  });

  assert.equal(await observation, 'unobserved');
  assertWithheld('baseline-presentation-drift');
});

test('content appearing under unchanged chrome is not judged a no-op either', async () => {
  // A toast over an untouched list: nothing the baseline named disappeared, so the tolerant
  // classifier says 'unchanged' — and the strict no-effect bar refuses to call it a scroll that did
  // nothing, in either direction.
  const toast = {
    type: 'StaticText',
    label: 'Saved',
    rect: { x: 24, y: 60, width: 120, height: 20 },
  } as SnapshotNode;
  const { observation } = observe({
    baseline: baselineOf(screen(0)),
    screens: [
      [...screen(0), toast],
      [...screen(0), toast],
    ],
  });

  assert.equal(await observation, 'unobserved');
  assertWithheld('surface-divergence');
});

test('a surface still in motion on the first read is a scroll that worked, not a no-op', async () => {
  const { observation, spy } = observe({
    baseline: baselineOf(screen(0)),
    screens: [screen(0), screen(-320)],
  });

  assert.equal(await observation, 'moved');
  assert.equal(spy.calls(), 2);
});

test('a surface that never holds still spends the budget and answers unobserved', async () => {
  // A spinner that comes and goes keeps every consecutive pair different while every element that
  // can be identified sits exactly where it was: `unchanged` against the baseline, never at rest.
  // Refusing here would fail a scroll over a busy screen, so the budget expires instead.
  const flicker = {
    type: 'ActivityIndicator',
    label: 'Loading',
    rect: { x: 340, y: 20, width: 20, height: 20 },
  } as SnapshotNode;
  const { observation, spy } = observe({
    baseline: baselineOf(screen(0)),
    screens: (attempt) => (attempt % 2 === 0 ? screen(0) : [...screen(0), flicker]),
    budgetMs: 40,
  });

  assert.equal(await observation, 'unobserved');
  assertWithheld('surface-unsettled');
  // The budget, not an accidental quiet pair: more than the two reads a verdict needs were taken.
  assert.ok(spy.calls() > 2);
});

test('a capture this command cannot read withholds the claim instead of failing the scroll', async () => {
  const unreadable = new Error('snapshot source unsupported');
  const { observation } = observe({
    baseline: baselineOf(screen(0)),
    screens: () => unreadable,
    budgetMs: 40,
  });

  assert.equal(await observation, 'unobserved');
  assertWithheld('capture-unreadable');
});

/**
 * The tree a scroll reads carries system chrome along with the app's content, and on Android that
 * chrome changes by itself: measured on the tester's `/catalog`, a status-bar icon alone turned the
 * pair into "changed" over a list that had not moved. Only a difference inside the scroller counts as
 * the gesture's doing — and the absence of one is not evidence that the gesture failed either.
 */
test('a difference outside the scrolled container does not buy the movement claim', async () => {
  const chrome = {
    type: 'Image',
    identifier: 'status-clock',
    label: '2:40',
    rect: { x: 20, y: 20, width: 60, height: 20 },
  } as SnapshotNode;
  const { observation, spy } = observe({
    baseline: baselineOf([...screen(0), chrome]),
    screens: [[...screen(0), { ...chrome, label: '2:41' } as SnapshotNode]],
  });

  assert.equal(await observation, 'unobserved');
  assertWithheld('change-outside-container');
  // The claim is confined by the tree already read: no second capture is spent to ask.
  assert.equal(spy.calls(), 1);
});

// Android reports `checked`, and a swipe that starts on a switch can flip it. On its own the flip is
// identity-invariant and reads as an unchanged surface. Beside a change elsewhere, such as the status
// clock ticking, the pair reads as changed, and the within-container check then sees a switch whose
// key differs at the same rect: a state flip, not the list moving, so it buys no movement claim.
test('a toggle the swipe flipped inside the container does not buy the movement claim', async () => {
  const chrome = {
    type: 'Image',
    identifier: 'status-clock',
    label: '2:40',
    rect: { x: 20, y: 20, width: 60, height: 20 },
  } as SnapshotNode;
  const toggle = (checked: boolean) =>
    ({
      type: 'android.widget.Switch',
      identifier: 'wifi-switch',
      label: 'Wi-Fi switch',
      checked,
      rect: { x: 300, y: 320, width: 60, height: 40 },
    }) as SnapshotNode;
  const { observation } = observe({
    baseline: baselineOf([...screen(0), chrome, toggle(false)]),
    screens: [[...screen(0), { ...chrome, label: '2:41' } as SnapshotNode, toggle(true)]],
  });

  assert.equal(await observation, 'unobserved');
  assertWithheld('change-outside-container');
});

test('a surface with no container to confine the claim to keeps the whole-surface answer', async () => {
  const rowsOnly = (offset: number) => screen(offset).filter((node) => node.type !== 'ScrollView');
  const { observation } = observe({
    baseline: baselineOf(rowsOnly(0)),
    screens: [rowsOnly(-300)],
  });

  assert.equal(await observation, 'moved');
});

/**
 * What a scroll owes is decided once, before the gesture dispatches, because every fact the plan reads
 * — the device family, the caller's flags, the tree the session holds — is about to change under it.
 */
test('a platform whose scroll dispatches no swipe is declined the observation', () => {
  const plan = planScrollMovement({
    device: MACOS_DEVICE,
    flags: undefined,
    session: makeSession('movement-plan-desktop'),
  });
  assertPlanKind(plan, 'declined');

  assert.equal(plan.reason, 'non-swipe-platform');
});

test('a caller that pays for its own observation is declined before the gesture', () => {
  const plan = planScrollMovement({
    device: IOS_SIMULATOR,
    flags: { postGestureStabilization: false },
    session: makeSession('movement-plan-replay', { snapshot: state(screen(0)) }),
  });
  assertPlanKind(plan, 'declined');

  assert.equal(plan.reason, 'caller-declined-observation');
});

test('a settle observation owns the outcome, so the scroll does not answer twice', () => {
  const plan = planScrollMovement({
    device: IOS_SIMULATOR,
    flags: { settle: true },
    session: makeSession('movement-plan-settle', { snapshot: state(screen(0)) }),
  });
  assertPlanKind(plan, 'declined');

  assert.equal(plan.reason, 'settle-observer-owns-outcome');
});

test('a session holding no tree cannot back a movement claim, and names why', () => {
  const plan = planScrollMovement({
    device: IOS_SIMULATOR,
    flags: undefined,
    session: makeSession('movement-plan-empty'),
  });
  assertPlanKind(plan, 'unobservable');

  assert.equal(plan.reason, 'stored-surface-unusable');
});

test('a tree the session no longer stands behind is refused as a baseline', () => {
  const session = makeSession('movement-plan-stale', { snapshot: state(screen(0)) });
  expireRefFrame(session);
  const plan = planScrollMovement({ device: IOS_SIMULATOR, flags: undefined, session });
  assertPlanKind(plan, 'unobservable');

  assert.equal(plan.reason, 'stored-surface-not-current');
});

test('a gesture nobody has read yet may still be moving the stored tree', () => {
  const session = makeSession('movement-plan-pending', { snapshot: state(screen(0)) });
  session.postGestureStabilization = { action: 'tap', positionals: [], markedAt: Date.now() };
  const plan = planScrollMovement({ device: IOS_SIMULATOR, flags: undefined, session });
  assertPlanKind(plan, 'unobservable');

  assert.equal(plan.reason, 'prior-gesture-unsettled');
});

test('a session standing behind its tree gets the read, at no extra capture cost', () => {
  const snapshot = state(screen(0));
  const plan = planScrollMovement({
    device: IOS_SIMULATOR,
    flags: undefined,
    session: makeSession('movement-plan-observe', { snapshot }),
  });
  assertPlanKind(plan, 'observe');

  assert.deepEqual(plan.baseline, readScrollSurfaceBaseline(snapshot));
});

test('the withheld answer carries its reason to the daemon log, not only to the response', () => {
  loggedDiagnostics.mockClear();

  const answer = reportScrollMovementUnobserved('down', 'stored-surface-not-current', {
    swipe: { midpoint: SWIPE_MIDPOINT, pixels: REQUESTED_PIXELS },
  });

  assert.equal(answer, 'unobserved');
  const entry = movementDiagnostic();
  assert.equal(entry.phase, 'scroll_movement_unobserved');
  assert.equal(entry.data.reason, 'stored-surface-not-current');
  assert.equal(entry.data.requestedPixels, REQUESTED_PIXELS);
});

test('the command that owes no observation logs which owner owes the read', () => {
  loggedDiagnostics.mockClear();

  reportScrollMovementNotApplicable('down', 'owner-without-capture');

  const entry = movementDiagnostic();
  assert.equal(entry.phase, 'scroll_movement_not_applicable');
  assert.equal(entry.data.reason, 'owner-without-capture');
});
