import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend } from '@agent-device/contracts/backend';
import type { PreresolvedInteractionTarget } from '@agent-device/contracts/interaction';
import type { MovingTargetBaseline } from '@agent-device/contracts/moving-target-gate';
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

// #3471, the gate's own claims: what a press pays when the session is idle, and which callers are
// never asked to pay anything. The accepted re-aim and the typed refusal are proven end-to-end by
// the ADR 0011 `targetStability` scenarios under test/integration/interaction-contract/ (both paths,
// on the real command surface), so what stays here is the accounting and the exemptions — the cases
// where re-resolving would replace one guard's evidence with another observation's.

const MID_FLIGHT_X = 240;
const RESTING_X = 10;
const BUTTON_Y = 240;

/** One button, reported at `x`: the same control at two positions is the whole fixture. */
function slideTree(x: number): SnapshotState {
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
      type: 'Button',
      label: 'Slide target',
      rect: { x, y: BUTTON_Y, width: 120, height: 50 },
      hittable: true,
    },
  ]);
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
          tree: { nodes: baselineTree.nodes },
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
  assert.equal(device.captures(), 2, 'both re-observations, none for the first resolution');
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
    preresolvedTarget: { ref: '@e2', node: carried.nodes[1]!, nodes: carried.nodes },
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
      return true;
    },
  );
  assert.deepEqual(device.taps(), [], 'an unmeasured position licenses no tap');
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
      assert.notEqual(details?.reason, INTERACTION_ERROR_REASONS.targetStillMoving);
      return true;
    },
  );
  assert.deepEqual(device.taps(), []);
});
