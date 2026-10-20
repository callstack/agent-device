import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { test } from 'vitest';
import type { AgentDeviceBackend } from '@agent-device/contracts/backend';
import type { PreresolvedInteractionTarget } from '@agent-device/contracts/interaction';
import type { MovingTargetBaseline } from '@agent-device/contracts/runtime-contract';
import type { Point, SnapshotState } from '@agent-device/kernel/snapshot';
import { readNodeLocalIdentity, readNodeStructuralDenotation } from '@agent-device/ad-script';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { INTERACTION_ERROR_REASONS } from '@agent-device/selectors/interaction-error';
import { createLocalArtifactAdapter } from '../../../io.ts';
import { createAgentDevice } from '../../../runtime.ts';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import { createMemorySessionStore } from '../../../command-runtime/runtime-factory.ts';
import { ref, selector } from './selector-read-utils.ts';
import { createFakeClock } from './__tests__/settle-device-fixtures.ts';
import {
  MOVING_TARGET_GATE_SAMPLE_GAP_MS,
  MOVING_TARGET_GATE_WINDOW_MS,
  movingTargetGateDecision,
} from './moving-target-gate.ts';

// #3471, the gate's own claims: what a press pays when the session is idle, and which callers are
// never asked to pay anything. The accepted re-aim and the typed refusal are proven end-to-end by
// the ADR 0011 `targetStability` scenarios under test/integration/interaction-contract/ (both paths,
// on the real command surface), so what stays here is the accounting and the exemptions — the cases
// where re-resolving would replace one guard's evidence with another observation's.

const MID_FLIGHT_X = 240;
const RESTING_X = 10;
const BUTTON_Y = 240;

/** One button, reported at `x`: the same control at two positions is the whole fixture. */
function slideTree(x: number, over?: { label?: string; surfaceBundleId?: string }): SnapshotState {
  return makeSnapshotState(
    [
      {
        index: 0,
        depth: 0,
        type: 'Application',
        label: 'App',
        rect: { x: 0, y: 0, width: 400, height: 800 },
      },
      {
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'Button',
        bundleId: 'com.example.app',
        label: over?.label ?? 'Slide target',
        rect: { x, y: BUTTON_Y, width: 120, height: 50 },
        hittable: true,
      },
    ],
    over?.surfaceBundleId ? { iosSystemSurfaceBundleId: over.surfaceBundleId } : undefined,
  );
}

function centerOf(x: number): Point {
  return { x: x + 60, y: BUTTON_Y + 25 };
}

/**
 * A press harness with a mutation history: `trees` answers captures in order, and `baseline` is the
 * session state a just-finished mutation leaves behind. `ageMs` is stated relative to the scenario
 * clock, which is the only clock the gate reads.
 */
function createGuardedDevice(params: {
  stored: SnapshotState;
  trees: SnapshotState[];
  baselineAgeMs?: number;
  baselineTree?: SnapshotState;
  preresolvedTarget?: PreresolvedInteractionTarget;
  expectedResolvedTarget?: boolean;
  /** The daemon-only ADR 0014 authorized frame: the tree a `@ref` resolves against for identity. */
  refFrame?: SnapshotState;
}): {
  press: (target: 'selector' | 'ref') => Promise<Point[]>;
  pressSelector: (expression: string) => Promise<Point[]>;
  pressPoint: () => Promise<Point[]>;
  captures: () => number;
  taps: () => Point[];
} {
  const clock = createFakeClock();
  let captureCount = 0;
  const taps: Point[] = [];
  const baselineTree = params.baselineTree ?? slideTree(MID_FLIGHT_X);
  const baseline: MovingTargetBaseline | undefined =
    params.baselineAgeMs === undefined
      ? undefined
      : {
          finishedAt: clock.now() - params.baselineAgeMs,
          // The baseline carries its surface the way a real one does: `surfaceScopedNodes` reads it
          // off the capture, so a fixture that wants a system-surface baseline asks for one.
          tree: {
            nodes: baselineTree.nodes,
            ...(baselineTree.iosSystemSurfaceBundleId
              ? { surfaceBundleId: baselineTree.iosSystemSurfaceBundleId }
              : {}),
          },
        };
  const device = createAgentDevice({
    backend: {
      platform: 'android',
      captureSnapshot: async () => {
        const snapshot = params.trees[Math.min(captureCount, params.trees.length - 1)]!;
        captureCount += 1;
        return { snapshot };
      },
      tap: async (_context, point) => {
        taps.push(point);
        return { ok: true };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([
      {
        name: 'default',
        snapshot: params.stored,
        ...(params.refFrame ? { refFrameSnapshot: params.refFrame } : {}),
        ...(baseline ? { movingTargetBaseline: baseline } : {}),
      },
    ]),
    policy: localCommandPolicy(),
    clock,
  });

  async function press(target: 'selector' | 'ref'): Promise<Point[]> {
    await device.interactions.press(
      target === 'selector' ? selector('label="Slide target"') : ref('@e2'),
      {
        session: 'default',
        ...(params.preresolvedTarget ? { preresolvedTarget: params.preresolvedTarget } : {}),
        ...(params.expectedResolvedTarget
          ? {
              expectedResolvedTarget: {
                identity: readNodeLocalIdentity(slideTree(MID_FLIGHT_X).nodes[1]!),
                structural: readNodeStructuralDenotation(
                  slideTree(MID_FLIGHT_X).nodes[1]!,
                  slideTree(MID_FLIGHT_X).nodes,
                ),
              },
            }
          : {}),
      },
    );
    return taps;
  }

  return {
    press,
    pressSelector: async (expression: string) => {
      await device.interactions.press(selector(expression), { session: 'default' });
      return taps;
    },
    pressPoint: async () => {
      await device.interactions.press(
        { kind: 'point', x: centerOf(RESTING_X).x, y: centerOf(RESTING_X).y },
        { session: 'default' },
      );
      return taps;
    },
    captures: () => captureCount,
    taps: () => taps,
  };
}

// The disturbing history every exemption below has to survive: a mutation that just finished, with
// a pre-action tree that does not show the target at the position being resolved.
const DISTURBING_HISTORY = { baselineAgeMs: 100, baselineTree: slideTree(-400) };

test('a session with no mutation history pays the gate nothing', async () => {
  const device = createGuardedDevice({
    stored: slideTree(RESTING_X),
    trees: [slideTree(RESTING_X)],
  });

  assert.deepEqual(await device.press('selector'), [centerOf(RESTING_X)]);
  assert.equal(device.captures(), 1, 'the resolution capture, and nothing from the gate');
});

test('a mutation outside the window leaves the resolved point standing', async () => {
  const device = createGuardedDevice({
    stored: slideTree(MID_FLIGHT_X),
    trees: [slideTree(MID_FLIGHT_X), slideTree(RESTING_X)],
    baselineAgeMs: 5_000,
    baselineTree: slideTree(-400),
  });

  assert.deepEqual(await device.press('selector'), [centerOf(MID_FLIGHT_X)]);
  assert.equal(device.captures(), 1, 'no re-observation once the window has closed');
});

test('the @ref path takes its own observations, because its resolution spends none', async () => {
  // ADR 0014 binds a ref to its authorized frame, so re-asking it would otherwise hand back the same
  // coordinates twice and the gate would certify a position it never re-measured. Two observations
  // is the claim; where they send the tap is the runtime-ref `targetStability` scenario's claim.
  const device = createGuardedDevice({
    stored: slideTree(MID_FLIGHT_X),
    trees: [slideTree(RESTING_X), slideTree(RESTING_X)],
    ...DISTURBING_HISTORY,
  });

  assert.deepEqual(await device.press('ref'), [centerOf(RESTING_X)]);
  assert.equal(device.captures(), 3, 'fresh observations span the target quiet window');
});

test('a raw-coordinate press has no resolved element to re-observe', async () => {
  const device = createGuardedDevice({
    stored: slideTree(RESTING_X),
    trees: [slideTree(RESTING_X)],
    ...DISTURBING_HISTORY,
  });

  assert.deepEqual(await device.pressPoint(), [centerOf(RESTING_X)]);
  assert.equal(device.captures(), 0, 'a point press neither captures nor re-observes');
});

test('a replay step keeps its own identity guard as the last word on the resolved node', async () => {
  // ADR 0012 step 4 judges THIS resolution against the verification tree. Re-resolving would swap
  // that evidence for a different observation, so the gate stays out and the press dispatches at the
  // point the replay step's guard accepted.
  const device = createGuardedDevice({
    stored: slideTree(MID_FLIGHT_X),
    trees: [slideTree(MID_FLIGHT_X), slideTree(RESTING_X)],
    ...DISTURBING_HISTORY,
    expectedResolvedTarget: true,
  });

  assert.deepEqual(await device.press('selector'), [centerOf(MID_FLIGHT_X)]);
  assert.equal(device.captures(), 1);
});

test("a mutating find's carried node is not second-guessed by position", async () => {
  // #1654: the node came out of the locator's own capture, which is the evidence its caller has.
  const carried = slideTree(MID_FLIGHT_X);
  const device = createGuardedDevice({
    stored: carried,
    trees: [carried, slideTree(RESTING_X)],
    ...DISTURBING_HISTORY,
    preresolvedTarget: { ref: '@e2', node: carried.nodes[1]!, tree: { nodes: carried.nodes } },
  });

  assert.deepEqual(await device.press('ref'), [centerOf(MID_FLIGHT_X)]);
  assert.equal(device.captures(), 0, 'neither the lookup nor a re-observation happens');
});

test('a ref the second observation cannot re-measure is refused, never self-agreed', async () => {
  // ADR 0014 lets a ref fall back to its authorized frame node when a newer observation does not
  // carry the same local identity — a positional coincidence must not retarget it. The gate has to
  // survive that: the frame's own rect is the one thing a rest judgement cannot be made from, since
  // it is the position the whole window exists to doubt. Here both looks land on the frame rect, so
  // a gate that mistook the fallback for an observation would "confirm" rest and dispatch.
  const frame = slideTree(RESTING_X);
  const device = createGuardedDevice({
    stored: frame,
    refFrame: frame,
    trees: [
      // The first re-observation names the same identity and is a real measurement; the second finds
      // a screen that names it nowhere, so resolution hands back the frame node.
      slideTree(RESTING_X),
      makeSnapshotState([
        {
          index: 0,
          depth: 0,
          type: 'StaticText',
          label: 'Done',
          rect: { x: 0, y: 0, width: 100, height: 40 },
        },
      ]),
    ],
    ...DISTURBING_HISTORY,
  });

  await assert.rejects(
    () => device.press('ref'),
    (error: unknown) => {
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, INTERACTION_ERROR_REASONS.targetStillMoving);
      assert.equal(details?.dispatched, 'no');
      // Nothing was measured, so nothing is reported: a caller reading `movedToRect` would take the
      // stale frame position for a fresh observation of where the target went.
      assert.equal(details?.movedToRect, undefined);
      // The `@ref` branch of the recovery, asserted on a real refusal rather than on the string: the
      // hint's only test was the contracts unit suite, and the hint now lives beside this refusal.
      assert.match(String(details?.hint), /snapshot -i/);
      assert.match(String(details?.hint), /ref frame/);
      // And no motion claim: this is the shape that measured NOTHING.
      assert.match(String(details?.hint), /no confirmed resting position/);
      assert.doesNotMatch(String(details?.hint), /was still moving/);
      return true;
    },
  );
  assert.deepEqual(device.taps(), [], 'an unmeasured position licenses no tap');
});

test('a surface that arrives between the two looks is not rest', async () => {
  // Rest is one position on one surface. The screening already refuses to compare positions across
  // surfaces for exactly the #2438 reason — a system sheet can carry the same control at the same
  // rect — and the two looks that certify rest are the same comparison. Without the surface check, a
  // sheet presented during the sample gap would let a press land on it while reporting agreement.
  const sheet = 'com.apple.springboard';
  const device = createGuardedDevice({
    stored: slideTree(MID_FLIGHT_X),
    trees: [
      // The resolution's own capture, then the two looks: the first on the app's content at rest,
      // the second on a sheet presented during the sample gap — same control, same rect, another
      // surface.
      slideTree(MID_FLIGHT_X),
      slideTree(RESTING_X),
      slideTree(RESTING_X, { surfaceBundleId: sheet }),
    ],
    ...DISTURBING_HISTORY,
  });

  await assert.rejects(
    () => device.press('selector'),
    (error: unknown) => {
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, INTERACTION_ERROR_REASONS.targetStillMoving);
      assert.equal(details?.dispatched, 'no');
      // The sheet's rect is not somewhere the app's target moved to, so the refusal reports no
      // position rather than one measured on a presentation this press never asked about.
      assert.equal(details?.movedToRect, undefined);
      return true;
    },
  );
  assert.deepEqual(device.taps(), [], 'the sheet never received a tap');
});

test('a target the wait loses is refused by resolution, not by a motion refusal', async () => {
  // The recheck asked the same question again and the answer was "no such element". That is a more
  // accurate account of a vanished target than "still moving" would be, and the caller's retry is a
  // fresh judgement rather than the same one.
  const device = createGuardedDevice({
    stored: slideTree(MID_FLIGHT_X),
    // The observation the re-observation takes no longer names the target at all.
    trees: [makeSnapshotState([])],
    ...DISTURBING_HISTORY,
  });

  await assert.rejects(
    () => device.press('ref'),
    (error: unknown) => {
      const details = (error as { details?: Record<string, unknown> }).details;
      // Named, not merely "not the motion refusal": any unrelated rejection would pass otherwise.
      assert.equal(details?.reason, INTERACTION_ERROR_REASONS.refNotFound);
      assert.equal(details?.dispatched, 'no');
      return true;
    },
  );
  assert.deepEqual(device.taps(), []);
});

test('a target newly arrived on a different surface is re-observed, not certified stationary', async () => {
  // The screening compares positions, so it is only meaningful inside one surface: an iOS system
  // sheet arriving over the app can carry the same-identity node at the same rect, and that is the
  // positional coincidence ADR 0014 refuses rather than evidence of rest. The press pays the
  // re-observations instead of tapping on the strength of the other surface's tree.
  const sheet = 'com.apple.springboard';
  const device = createGuardedDevice({
    stored: slideTree(MID_FLIGHT_X, { surfaceBundleId: sheet }),
    trees: [
      slideTree(MID_FLIGHT_X, { surfaceBundleId: sheet }),
      slideTree(RESTING_X, { surfaceBundleId: sheet }),
      slideTree(RESTING_X, { surfaceBundleId: sheet }),
    ],
    baselineAgeMs: 100,
    // The baseline shows the target exactly where the press resolved it — the `stationary` shape —
    // but it is the app's tree, not the sheet's.
    baselineTree: slideTree(MID_FLIGHT_X),
  });

  assert.deepEqual(await device.press('selector'), [centerOf(RESTING_X)]);
  assert.equal(device.captures(), 4, 'resolution plus observations across the quiet window');
});

test('a replacement that took the ref at the frame coordinates is refused, not agreed', async () => {
  // ADR 0014 keeps the authorized frame node when the captured node's identity differs, so both
  // looks land on the frame rect — and a gate that read rect agreement alone would certify rest and
  // dispatch onto a control it never measured. Same ref, same position, different element: the
  // look measured something, but not the target.
  const frame = slideTree(RESTING_X);
  const device = createGuardedDevice({
    stored: frame,
    refFrame: frame,
    trees: [replacementAtRestingRect(), replacementAtRestingRect()],
    ...DISTURBING_HISTORY,
  });

  await assert.rejects(
    () => device.press('ref'),
    (error: unknown) => {
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, INTERACTION_ERROR_REASONS.targetStillMoving);
      // A look that measured no target reports no position: the frame rect is the value the whole
      // window exists to doubt, and publishing it as `movedToRect` would read as a fresh observation.
      assert.equal(details?.movedToRect, undefined);
      return true;
    },
  );
  assert.deepEqual(device.taps(), [], 'one look that measured no target ends the recheck');
});

/** The `@e2` position, held by a control with a different local identity. */
function replacementAtRestingRect(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'App',
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      ref: 'e2',
      type: 'Button',
      label: 'Something else',
      rect: { x: RESTING_X, y: BUTTON_Y, width: 120, height: 50 },
      hittable: true,
    },
  ]);
}

test('the refused selector press publishes a wait that survives the shell', async () => {
  // The hint is copied into a shell, and a naive single-quote wrap over a selector carrying an
  // apostrophe would end the word early — teaching a recovery that cannot run.
  const label = "It's moving";
  const device = createGuardedDevice({
    stored: slideTree(MID_FLIGHT_X, { label }),
    // Still moving at the end of the window: the two re-observations disagree.
    trees: Array.from({ length: 40 }, (_, index) => slideTree(120 + (index % 2) * 40, { label })),
    baselineAgeMs: 100,
    baselineTree: slideTree(-400, { label }),
  });

  await assert.rejects(
    () => device.pressSelector('label="It\'s moving"'),
    (error: unknown) => {
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, INTERACTION_ERROR_REASONS.targetStillMoving);
      assert.match(String(details?.hint), /wait 'label="It'\\''s moving"'/);
      return true;
    },
  );
});

// The pure decision, isolated from the press so the window has exactly one reading. Whether two
// captures count as one position is kernel's `areCapturedRectsAtSamePosition`, tested beside the
// band it owns (`packages/kernel/src/rect-center.test.ts`).

// --- is a second observation owed? ---

test('a session with no mutation clock is idle and owes nothing', () => {
  // `targetShownAtRest` is deliberately the disturbing kind here: with no clock there is nothing to
  // wait out, and an absent clock must not read as "a mutation just finished".
  const decision = movingTargetGateDecision({
    baselineFinishedAtMs: undefined,
    targetShownAtRest: false,
    nowMs: 10_000,
  });

  assert.deepEqual(decision, { kind: 'idle' });
});

test('a target the previous action left in place is answered without a re-observation', () => {
  const decision = movingTargetGateDecision({
    baselineFinishedAtMs: 9_900,
    targetShownAtRest: true,
    nowMs: 10_000,
  });

  assert.deepEqual(decision, { kind: 'stationary' });
});

test('the window is measured from the mutation END, so only what is LEFT of it is waited out', () => {
  // The action finished 400 ms ago; a full window of waiting would be a 900 ms pause on a press
  // whose surface has already been quiet for 400 ms.
  const decision = movingTargetGateDecision({
    baselineFinishedAtMs: 9_600,
    targetShownAtRest: false,
    nowMs: 10_000,
  });

  assert.deepEqual(decision, { kind: 'recheck', waitMs: 100 });
});

test('the declared window is the 500 ms transition budget, and its edge decides the branch', () => {
  // The edge is exclusive: at exactly the budget the resolved point already stands, because an
  // action that finished a full window ago has no claim on this press.
  assert.equal(MOVING_TARGET_GATE_WINDOW_MS, 500);
  const atEdge = movingTargetGateDecision({
    baselineFinishedAtMs: 10_000 - MOVING_TARGET_GATE_WINDOW_MS,
    targetShownAtRest: false,
    nowMs: 10_000,
  });
  const inside = movingTargetGateDecision({
    baselineFinishedAtMs: 9_600,
    targetShownAtRest: false,
    nowMs: 10_000,
  });
  const outside = movingTargetGateDecision({
    baselineFinishedAtMs: 9_400,
    targetShownAtRest: false,
    nowMs: 10_000,
  });

  assert.deepEqual(atEdge, { kind: 'not-recent' });
  assert.equal(inside.kind, 'recheck');
  assert.equal(outside.kind, 'not-recent');
});

test('inside the window, only a tree that shows the target at rest excuses the re-observation', () => {
  // One bit carries the whole screening verdict, because that is all this branch can use: absent,
  // ambiguous, and moved all mean the same thing here — the session cannot show where the target
  // came to rest, so it owes the look.
  for (const targetShownAtRest of [false, true] as const) {
    const decision = movingTargetGateDecision({
      baselineFinishedAtMs: 9_950,
      targetShownAtRest,
      nowMs: 10_000,
    });

    assert.equal(
      decision.kind,
      targetShownAtRest ? 'stationary' : 'recheck',
      `targetShownAtRest ${String(targetShownAtRest)}`,
    );
  }
});

test('the wait never drops below one sample gap, even as the window closes', () => {
  // Re-observing immediately would compare two captures the same animation frame could produce,
  // and agreement would then be a timing accident rather than the target having stopped.
  const decision = movingTargetGateDecision({
    baselineFinishedAtMs: 9_520,
    targetShownAtRest: false,
    nowMs: 10_000,
  });

  assert.deepEqual(decision, { kind: 'recheck', waitMs: MOVING_TARGET_GATE_SAMPLE_GAP_MS });
});

test('a clock skew ahead of the mutation does not produce a negative wait', () => {
  const decision = movingTargetGateDecision({
    baselineFinishedAtMs: 10_100,
    targetShownAtRest: false,
    nowMs: 10_000,
  });

  assert.ok(decision.kind === 'recheck');
  assert.ok(decision.waitMs >= MOVING_TARGET_GATE_SAMPLE_GAP_MS);
});

test('Android admits the same uniquely identified target after another node reindexes its observation', async () => {
  const frame = slideTree(MID_FLIGHT_X);
  frame.nodes[1]!.identifier = 'stable-target';
  const fresh = slideTree(RESTING_X);
  fresh.nodes[1]!.identifier = 'stable-target';
  fresh.nodes[1]!.index = 2;
  fresh.nodes[1]!.ref = 'e3';
  fresh.nodes.splice(1, 0, {
    ref: 'e2',
    index: 1,
    type: 'Text',
    label: 'New status',
    parentIndex: 0,
    depth: 1,
  });
  const device = createGuardedDevice({
    stored: frame,
    refFrame: frame,
    trees: [fresh],
    ...DISTURBING_HISTORY,
  });
  assert.deepEqual(await device.press('ref'), [centerOf(RESTING_X)]);
});

test('Android refuses to certify an identity duplicated in the new observation', async () => {
  const frame = slideTree(MID_FLIGHT_X);
  frame.nodes[1]!.identifier = 'stable-target';
  const fresh = slideTree(RESTING_X);
  fresh.nodes[1]!.identifier = 'stable-target';
  fresh.nodes.push({
    ...fresh.nodes[1]!,
    index: 2,
    ref: 'e3',
    rect: { x: 160, y: BUTTON_Y, width: 120, height: 50 },
  });
  const device = createGuardedDevice({
    stored: frame,
    refFrame: frame,
    trees: [fresh],
    ...DISTURBING_HISTORY,
  });
  await assert.rejects(
    () => device.press('ref'),
    (error: unknown) => {
      assert.equal(
        (error as AppError).details?.reason,
        INTERACTION_ERROR_REASONS.targetStillMoving,
      );
      return true;
    },
  );
  assert.deepEqual(device.taps(), []);
});

test('Android refuses to adopt matching identity from another application', async () => {
  const frame = slideTree(MID_FLIGHT_X);
  frame.nodes[1]!.identifier = 'stable-target';
  const fresh = slideTree(RESTING_X);
  fresh.nodes[1]!.identifier = 'stable-target';
  fresh.nodes[1]!.bundleId = 'com.example.other';
  const device = createGuardedDevice({
    stored: frame,
    refFrame: frame,
    trees: [fresh],
    ...DISTURBING_HISTORY,
  });
  await assert.rejects(
    () => device.press('ref'),
    (error: unknown) => {
      assert.equal(
        (error as AppError).details?.reason,
        INTERACTION_ERROR_REASONS.targetStillMoving,
      );
      return true;
    },
  );
  assert.deepEqual(device.taps(), []);
});
