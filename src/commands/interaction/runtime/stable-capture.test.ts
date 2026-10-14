import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import type { AgentDeviceBackend } from '@agent-device/contracts/backend';
import { makeSnapshotState } from '@agent-device/capture-kit/snapshot-state-fixtures';
import { iosInteractiveKeyboardCaptureNodes } from '@agent-device/capture-kit/snapshot-chrome-fixtures';
import { createLocalArtifactAdapter } from '../../../io.ts';
import { createAgentDevice } from '../../../runtime.ts';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import { runStableCaptureLoop } from './stable-capture.ts';
import {
  elementCatalogTabSnapshot,
  elementPushedDetailSnapshot,
  elementSettingsSnapshot,
  elementSettledRoomSnapshot,
  elementSettingsTabSnapshot,
  elementThreadsNoticeSnapshot,
  elementTransientRoomSnapshot,
  systemPermissionPromptSnapshot,
} from './stable-capture.fixtures.ts';
import { createMemorySessionStore } from '../../../command-runtime/runtime-factory.ts';

const BROAD_TRANSITION_PARAMS = {
  quietMs: 500,
  timeoutMs: 5_000,
  broadTransitionBaseline: { nodes: elementThreadsNoticeSnapshot.nodes },
};

// Each #1831 case below runs at BOTH windows. The confirmation used to switch itself off for a
// requested window under the default, so `--settle-quiet 150` — what tester-army/e2e passes — got no
// guard at all while 500 got a 1.5 s one (#3470).
for (const requestedQuietMs of [500, 150]) {
  const confirmationFloor = Math.max(requestedQuietMs, 1_500);

  test(`settle confirms a broad screen replacement beyond a self-consistent transitional tree (quiet ${requestedQuietMs}ms)`, async () => {
    const { runtime } = transitionRuntime();

    const outcome = await runStableCaptureLoop(
      runtime,
      { session: 'default' },
      { ...BROAD_TRANSITION_PARAMS, quietMs: requestedQuietMs },
    );

    assert.equal(outcome.settled, true);
    assert.equal(
      outcome.lastCapture?.snapshot.nodes.some((node) => node.label === 'action file'),
      false,
    );
    assert.ok(
      outcome.waitedMs >= confirmationFloor,
      `settled transitional tree after ${outcome.waitedMs}ms`,
    );
  });

  test(`settle confirms a broad screen replacement when capture recovers to private AX (quiet ${requestedQuietMs}ms)`, async () => {
    const { runtime } = transitionRuntime({ captureBackend: 'private-ax' });

    const outcome = await runStableCaptureLoop(
      runtime,
      { session: 'default' },
      { ...BROAD_TRANSITION_PARAMS, quietMs: requestedQuietMs },
    );

    assert.equal(outcome.settled, true);
    assert.equal(
      outcome.lastCapture?.snapshot.nodes.some((node) => node.label === 'action file'),
      false,
    );
    assert.ok(
      outcome.waitedMs >= confirmationFloor,
      `settled transitional tree after ${outcome.waitedMs}ms`,
    );
  });

  test(`settle confirms a broad replacement that begins after the first post-action capture (quiet ${requestedQuietMs}ms)`, async () => {
    const { runtime } = transitionRuntime({
      captureBackend: 'private-ax',
      firstCaptureKeepsBaseline: true,
      settledAtMs: 1_200,
    });

    const outcome = await runStableCaptureLoop(
      runtime,
      { session: 'default' },
      { ...BROAD_TRANSITION_PARAMS, quietMs: requestedQuietMs },
    );

    assert.equal(outcome.settled, true);
    assert.equal(
      outcome.lastCapture?.snapshot.nodes.some((node) => node.label === 'action file'),
      false,
    );
    assert.ok(
      outcome.waitedMs >= confirmationFloor,
      `settled delayed transition after ${outcome.waitedMs}ms`,
    );
  });

  test(`settle confirms against the pre-action tree when the stored snapshot already advanced (quiet ${requestedQuietMs}ms)`, async () => {
    const { runtime } = transitionRuntime({
      sessionSnapshot: { ...elementTransientRoomSnapshot, backend: undefined, producer: undefined },
      settledAtMs: 1_200,
    });

    const outcome = await runStableCaptureLoop(
      runtime,
      { session: 'default' },
      { ...BROAD_TRANSITION_PARAMS, quietMs: requestedQuietMs },
    );

    assert.equal(outcome.settled, true);
    assert.equal(
      outcome.lastCapture?.snapshot.nodes.some((node) => node.label === 'action file'),
      false,
    );
    assert.ok(
      outcome.waitedMs >= confirmationFloor,
      `settled advanced-session transition after ${outcome.waitedMs}ms`,
    );
  });

  test(`settle confirms an iOS broad replacement when capture omits snapshot backend provenance (quiet ${requestedQuietMs}ms)`, async () => {
    const { runtime } = transitionRuntime({
      omitSnapshotBackend: true,
      settledAtMs: 1_200,
    });

    const outcome = await runStableCaptureLoop(
      runtime,
      { session: 'default' },
      {
        ...BROAD_TRANSITION_PARAMS,
        quietMs: requestedQuietMs,
        // Presented iOS modals can be complete interaction captures without retaining the
        // Application root in their projection.
        broadTransitionBaseline: { nodes: elementThreadsNoticeSnapshot.nodes.slice(1) },
      },
    );

    assert.equal(outcome.settled, true);
    assert.equal(
      outcome.lastCapture?.snapshot.nodes.some((node) => node.label === 'action file'),
      false,
    );
    assert.ok(
      outcome.waitedMs >= confirmationFloor,
      `settled backend-less transition after ${outcome.waitedMs}ms`,
    );
  });

  test(`settle confirms a tiny modal replacement through a partial post-action projection (quiet ${requestedQuietMs}ms)`, async () => {
    const { runtime } = transitionRuntime({ omitViewportRoot: true, settledAtMs: 1_200 });

    const outcome = await runStableCaptureLoop(
      runtime,
      { session: 'default' },
      { ...BROAD_TRANSITION_PARAMS, quietMs: requestedQuietMs },
    );

    assert.equal(outcome.settled, true);
    assert.equal(
      outcome.lastCapture?.snapshot.nodes.some((node) => node.label === 'action file'),
      false,
    );
    assert.ok(
      outcome.waitedMs >= confirmationFloor,
      `settled partial transitional tree after ${outcome.waitedMs}ms`,
    );
  });
}

test('regular captures settle from visible semantics while offscreen rows churn', async () => {
  let elapsedMs = 0;
  const clock = {
    now: () => elapsedMs,
    sleep: async (ms: number) => {
      elapsedMs += ms;
    },
  };
  const snapshots = [
    elementSettingsSnapshot([1_138, 1_423, 2_144, 2_434]),
    elementSettingsSnapshot([1_187, 1_423, 1_858, 2_144, 2_261]),
  ];
  let captures = 0;
  const runtime = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => ({ snapshot: snapshots[captures++ % snapshots.length]! }),
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore(),
    policy: localCommandPolicy(),
    clock,
  });

  const outcome = await runStableCaptureLoop(
    runtime,
    { session: 'default' },
    { quietMs: 100, timeoutMs: 1_000 },
  );

  assert.equal(outcome.settled, true);
  assert.equal(outcome.captures, 2);
  assert.ok(outcome.waitedMs < 200, `settled after ${outcome.waitedMs}ms`);
});

test('settle confirms a broad screen replacement beyond a self-consistent transitional tree', async () => {
  const { runtime } = transitionRuntime();

  const outcome = await runStableCaptureLoop(
    runtime,
    { session: 'default' },
    BROAD_TRANSITION_PARAMS,
  );

  assert.equal(outcome.settled, true);
  assert.equal(
    outcome.lastCapture?.snapshot.nodes.some((node) => node.label === 'action file'),
    false,
  );
  assert.ok(outcome.waitedMs >= 1_500, `settled transitional tree after ${outcome.waitedMs}ms`);
});

test('settle confirms a broad screen replacement when capture recovers to private AX', async () => {
  const { runtime } = transitionRuntime({ captureBackend: 'private-ax' });

  const outcome = await runStableCaptureLoop(
    runtime,
    { session: 'default' },
    BROAD_TRANSITION_PARAMS,
  );

  assert.equal(outcome.settled, true);
  assert.equal(
    outcome.lastCapture?.snapshot.nodes.some((node) => node.label === 'action file'),
    false,
  );
  assert.ok(outcome.waitedMs >= 1_500, `settled transitional tree after ${outcome.waitedMs}ms`);
});

test('settle confirms a broad replacement that begins after the first post-action capture', async () => {
  const { runtime } = transitionRuntime({
    captureBackend: 'private-ax',
    firstCaptureKeepsBaseline: true,
    settledAtMs: 1_200,
  });

  const outcome = await runStableCaptureLoop(
    runtime,
    { session: 'default' },
    BROAD_TRANSITION_PARAMS,
  );

  assert.equal(outcome.settled, true);
  assert.equal(
    outcome.lastCapture?.snapshot.nodes.some((node) => node.label === 'action file'),
    false,
  );
  assert.ok(outcome.waitedMs >= 1_500, `settled delayed transition after ${outcome.waitedMs}ms`);
});

test('settle confirms against the pre-action tree when the stored snapshot already advanced', async () => {
  const { runtime } = transitionRuntime({
    sessionSnapshot: { ...elementTransientRoomSnapshot, backend: undefined, producer: undefined },
    settledAtMs: 1_200,
  });

  const outcome = await runStableCaptureLoop(
    runtime,
    { session: 'default' },
    BROAD_TRANSITION_PARAMS,
  );

  assert.equal(outcome.settled, true);
  assert.equal(
    outcome.lastCapture?.snapshot.nodes.some((node) => node.label === 'action file'),
    false,
  );
  assert.ok(
    outcome.waitedMs >= 1_500,
    `settled advanced-session transition after ${outcome.waitedMs}ms`,
  );
});

test('settle confirms an iOS broad replacement when capture omits snapshot backend provenance', async () => {
  const { runtime } = transitionRuntime({
    omitSnapshotBackend: true,
    settledAtMs: 1_200,
  });

  const outcome = await runStableCaptureLoop(
    runtime,
    { session: 'default' },
    {
      ...BROAD_TRANSITION_PARAMS,
      // Presented iOS modals can be complete interaction captures without retaining the
      // Application root in their projection.
      broadTransitionBaseline: { nodes: elementThreadsNoticeSnapshot.nodes.slice(1) },
    },
  );

  assert.equal(outcome.settled, true);
  assert.equal(
    outcome.lastCapture?.snapshot.nodes.some((node) => node.label === 'action file'),
    false,
  );
  assert.ok(
    outcome.waitedMs >= 1_500,
    `settled backend-less transition after ${outcome.waitedMs}ms`,
  );
});

test('settle confirms a tiny modal replacement through a partial post-action projection', async () => {
  const { runtime } = transitionRuntime({ omitViewportRoot: true, settledAtMs: 1_200 });

  const outcome = await runStableCaptureLoop(
    runtime,
    { session: 'default' },
    BROAD_TRANSITION_PARAMS,
  );

  assert.equal(outcome.settled, true);
  assert.equal(
    outcome.lastCapture?.snapshot.nodes.some((node) => node.label === 'action file'),
    false,
  );
  assert.ok(
    outcome.waitedMs >= 1_500,
    `settled partial transitional tree after ${outcome.waitedMs}ms`,
  );
});

test('settle confirms the dismissal of a presented surface larger than a tiny tree', async () => {
  // A blocking system prompt projects 6 nodes — over `TINY_STABLE_TREE_NODE_COUNT` — and the
  // captures after it arrive rootless. The producer's `presented` fact is what arms the
  // confirmation; without it this is the larger partial projection below, which keeps the plain
  // window.
  const prompt = systemPermissionPromptSnapshot();
  const { runtime } = transitionRuntime({
    presented: prompt,
    dismissesTo: elementCatalogTabSnapshot(),
    omitViewportRoot: true,
    settledAtMs: 1_200,
  });

  const outcome = await runStableCaptureLoop(
    runtime,
    { session: 'default' },
    {
      quietMs: 150,
      timeoutMs: 5_000,
      broadTransitionBaseline: { nodes: prompt.nodes, presentedSurface: 'presented' },
    },
  );

  assert.equal(outcome.settled, true);
  assert.ok(outcome.waitedMs >= 1_500, `settled prompt dismissal after ${outcome.waitedMs}ms`);
});

// The three navigation cases #3470 complains about. Each is a BROAD replacement by the identity
// ratio — both screens project a complete viewport and share under half their node identities. A
// baseline whose producer read no presented surface has no dismissal to confirm, so they keep the
// plain window; a producer that cannot answer keeps the parent's arming, which confirms them.
const NAVIGATION_TRANSITIONS = [
  ['a tab switch', elementCatalogTabSnapshot(), elementSettingsTabSnapshot()],
  ['a push', elementCatalogTabSnapshot(), elementPushedDetailSnapshot()],
  [
    // The screen a push LANDS ON can be tiny, and that must not arm the confirmation either: only
    // the surface being dismissed is the trigger.
    'a push onto a nearly-empty screen',
    elementCatalogTabSnapshot(),
    elementThreadsNoticeSnapshot,
  ],
] as const;
for (const [label, from, to] of NAVIGATION_TRANSITIONS) {
  test(`settle keeps the quiet window across ${label} from a screen with nothing presented`, async () => {
    const { runtime } = staticSnapshotRuntime(to);

    const outcome = await runStableCaptureLoop(
      runtime,
      { session: 'default' },
      {
        quietMs: 500,
        timeoutMs: 5_000,
        broadTransitionBaseline: { nodes: from.nodes, presentedSurface: 'absent' },
      },
    );

    assert.equal(outcome.settled, true);
    assert.ok(
      outcome.waitedMs < 800,
      `${label} settled after ${outcome.waitedMs}ms with ${outcome.captures} captures`,
    );
  });

  test(`settle still confirms ${label} when the producer cannot say what was presented`, async () => {
    const { runtime } = staticSnapshotRuntime(to);

    const outcome = await runStableCaptureLoop(
      runtime,
      { session: 'default' },
      {
        quietMs: 500,
        timeoutMs: 5_000,
        broadTransitionBaseline: { nodes: from.nodes, presentedSurface: 'unknown' },
      },
    );

    assert.equal(outcome.settled, true);
    assert.ok(outcome.waitedMs >= 1_500, `${label} settled after ${outcome.waitedMs}ms`);
  });
}

test('a dismissal confirmation is not dropped by a later empty projection', async () => {
  // A confirmation is a fact about the transition, so once armed it holds the floor for the rest of
  // the run: later captures that cannot support the comparison (here, empty projections that match
  // each other) never return the run to the caller's shorter window.
  const { runtime } = transitionRuntime({
    settledAtMs: 0,
    emptyProjectionAtCaptures: [2, 3],
  });

  const outcome = await runStableCaptureLoop(
    runtime,
    { session: 'default' },
    {
      quietMs: 150,
      timeoutMs: 5_000,
      broadTransitionBaseline: { nodes: elementThreadsNoticeSnapshot.nodes },
    },
  );

  assert.equal(outcome.settled, true);
  assert.ok(
    outcome.waitedMs >= 1_500,
    `empty projection disarmed the confirmation: settled after ${outcome.waitedMs}ms`,
  );
  assert.ok(
    outcome.lastCapture!.snapshot.nodes.length > 0,
    'settled on an empty projection instead of the dismissed screen',
  );
});

// The two arming inputs that belong to the capture, not to the run: the viewport-root completeness
// and the declared capture backend. A dismissal of anything bigger than an alert or sheet (the
// `<= TINY_STABLE_TREE_NODE_COUNT` escape hatch) has to meet BOTH before the confirmation may arm,
// and a mid-animation first read that misses either one leaves the question open for the next
// capture rather than settling the run on its plain window. These captures declare no producer, so
// that plain window is the 500 ms default; the 1.5 s floor is what the assertions tell apart.
const MID_ANIMATION_FIRST_CAPTURES: Array<
  [string, NonNullable<Parameters<typeof transitionRuntime>[0]>]
> = [
  ['a rootless first capture', { rootlessUntilMs: 400 }],
  ['an empty first capture', { emptyProjectionAtCaptures: [1] }],
  ['a first capture read through another channel', { otherChannelAtCaptures: [1] }],
];
for (const [label, midAnimation] of MID_ANIMATION_FIRST_CAPTURES) {
  test(`settle arms the confirmation on the first rooted XCTest capture after ${label}`, async () => {
    const { runtime } = transitionRuntime({ settledAtMs: 0, ...midAnimation });

    const outcome = await runStableCaptureLoop(
      runtime,
      { session: 'default' },
      {
        timeoutMs: 5_000,
        // A full-screen settings table: the tiny-presented-baseline escape hatch does not apply, so
        // arming depends entirely on the captures below.
        broadTransitionBaseline: {
          nodes: elementSettingsSnapshot([1_138, 1_423, 2_144, 2_434]).nodes,
        },
      },
    );

    assert.equal(outcome.settled, true);
    assert.equal(
      outcome.lastCapture?.snapshot.nodes.some((node) => node.label === 'action file'),
      false,
    );
    assert.ok(
      outcome.waitedMs >= 1_500,
      `${label} ruled the confirmation out for the run: settled after ${outcome.waitedMs}ms`,
    );
  });
}

test('settle keeps the default quiet window for a larger partial projection', async () => {
  const { runtime } = transitionRuntime({ omitViewportRoot: true, settledAtMs: 1_200 });

  const outcome = await runStableCaptureLoop(
    runtime,
    { session: 'default' },
    {
      ...BROAD_TRANSITION_PARAMS,
      broadTransitionBaseline: {
        nodes: elementSettingsSnapshot([1_138, 1_423, 2_144, 2_434]).nodes,
      },
    },
  );

  assert.equal(outcome.settled, true);
  assert.equal(
    outcome.lastCapture?.snapshot.nodes.some((node) => node.label === 'action file'),
    true,
  );
  assert.ok(outcome.waitedMs < 800, `partial projection settled after ${outcome.waitedMs}ms`);
});

test('settle confirms a broad replacement on a caller window shorter than the confirmation floor', async () => {
  // The counterpart of the loop above at the tightest window a caller realistically asks for. The
  // 25 ms cadence still applies — the loop keeps sampling at that grid — but the confirmation floor,
  // not the window, decides when a broad replacement is trusted (#3470).
  const { runtime } = transitionRuntime({ settledAtMs: 1_200 });

  const outcome = await runStableCaptureLoop(
    runtime,
    { session: 'default' },
    { ...BROAD_TRANSITION_PARAMS, quietMs: 25 },
  );

  assert.equal(outcome.settled, true);
  assert.equal(
    outcome.lastCapture?.snapshot.nodes.some((node) => node.label === 'action file'),
    false,
  );
  assert.ok(
    outcome.waitedMs >= 1_500,
    `short quiet window switched the confirmation off: settled after ${outcome.waitedMs}ms`,
  );
  // Cadence follows the window in force, so the extended wait is sampled on the default grid:
  // 10 captures here, 109 when the loop keeps polling at the caller's 25 ms. Each of those is a
  // capture round trip, so the tight grid would turn a 1.5 s confirmation into ~1.5 s of reads.
  assert.ok(
    outcome.captures <= 12,
    `confirmation sampled on the caller's tight grid: ${outcome.captures} captures`,
  );
});

test('settle keeps the default quiet window for a backend-less overlapping local mutation', async () => {
  const localMutation = {
    ...elementSettledRoomSnapshot,
    nodes: elementSettledRoomSnapshot.nodes.map((node) =>
      node.label === 'Upload' ? { ...node, label: 'Add attachment' } : node,
    ),
  };
  const { runtime } = staticSnapshotRuntime(withoutSnapshotBackend(localMutation, true));

  const outcome = await runStableCaptureLoop(
    runtime,
    { session: 'default' },
    {
      quietMs: 500,
      timeoutMs: 5_000,
      broadTransitionBaseline: { nodes: elementSettledRoomSnapshot.nodes },
    },
  );

  assert.equal(outcome.settled, true);
  assert.ok(outcome.waitedMs >= 500, `settled before the requested quiet window`);
  assert.ok(outcome.waitedMs < 800, `local mutation settled after ${outcome.waitedMs}ms`);
});

// Why keyboard chrome is stripped from BOTH sides rather than the candidate
// only: with the keyboard up on both sides, its ~50 identical chrome nodes
// dominate the denominator, so no shared-identity ratio reaches the broad bar
// — on main too (keys counted on both sides, already shared). Stripping the
// same projection the settle diff collapses therefore only ever removes the
// false broad verdict (keyboard arrival counted as replacement); it cannot
// disarm a broad check that previously fired. The check that replaces the
// keyboard-up pair is the one the fill actually performs: baseline without
// the keyboard, capture with it, overlapping content — default window.
test('settle keeps the default quiet window when only keyboard chrome arrives', async () => {
  const keyboardUp = makeSnapshotState(iosInteractiveKeyboardCaptureNodes(), {
    backend: 'xctest',
    snapshotQuality: { state: 'healthy', backend: 'tree' },
  });
  const { runtime } = staticSnapshotRuntime(keyboardUp);

  const outcome = await runStableCaptureLoop(
    runtime,
    { session: 'default' },
    {
      quietMs: 500,
      timeoutMs: 5_000,
      broadTransitionBaseline: { nodes: keyboardUp.nodes.filter((node) => node.index <= 30) },
    },
  );

  assert.equal(outcome.settled, true);
  assert.ok(outcome.waitedMs < 800, `keyboard arrival settled after ${outcome.waitedMs}ms`);
});

function staticSnapshotRuntime(snapshot: SnapshotState) {
  let elapsedMs = 0;
  const runtime = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => ({ snapshot }),
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot }]),
    policy: localCommandPolicy(),
    clock: {
      now: () => elapsedMs,
      sleep: async (ms: number) => {
        elapsedMs += ms;
      },
    },
  });
  return { runtime };
}

function transitionRuntime(
  options: {
    captureBackend?: 'tree' | 'private-ax';
    firstCaptureKeepsBaseline?: boolean;
    omitSnapshotBackend?: boolean;
    omitViewportRoot?: boolean;
    settledAtMs?: number;
    sessionSnapshot?: SnapshotState;
    /** 1-based capture indices that answer with an empty projection (mid-animation read). */
    emptyProjectionAtCaptures?: number[];
    /** Captures taken before this deadline omit the viewport root (mid-animation read). */
    rootlessUntilMs?: number;
    /** 1-based capture indices that declare a non-XCTest capture channel. */
    otherChannelAtCaptures?: number[];
    /** The surface the action dismisses; defaults to #1831's notice. */
    presented?: SnapshotState;
    /** What the screen under it looks like once the dismissal completes. */
    dismissesTo?: SnapshotState;
  } = {},
) {
  const captureBackend = options.captureBackend ?? 'tree';
  const settledAtMs = options.settledAtMs ?? 800;
  const presented = options.presented ?? elementThreadsNoticeSnapshot;
  const dismissesTo = options.dismissesTo ?? elementSettledRoomSnapshot;
  let elapsedMs = 0;
  let captures = 0;
  const clock = {
    now: () => elapsedMs,
    sleep: async (ms: number) => {
      elapsedMs += ms;
    },
  };
  const runtime = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => {
        const keepsBaseline = options.firstCaptureKeepsBaseline === true && captures === 0;
        captures += 1;
        if (options.emptyProjectionAtCaptures?.includes(captures)) {
          return {
            snapshot: withCaptureBackend(
              { ...elementSettledRoomSnapshot, nodes: [] },
              captureBackend,
            ),
          };
        }
        const snapshot = keepsBaseline
          ? presented
          : withCaptureBackend(
              elapsedMs < settledAtMs ? elementTransientRoomSnapshot : dismissesTo,
              captureBackend,
            );
        const rootless =
          options.omitViewportRoot === true ||
          (options.rootlessUntilMs !== undefined && elapsedMs < options.rootlessUntilMs);
        const declaresOtherChannel = options.otherChannelAtCaptures?.includes(captures) === true;
        const rootlessSnapshot = rootless
          ? { ...snapshot, nodes: snapshot.nodes.slice(1) }
          : snapshot;
        return {
          snapshot: withoutSnapshotBackend(
            declaresOtherChannel
              ? {
                  ...rootlessSnapshot,
                  backend: 'android' as const,
                  producer: 'android-uiautomator' as const,
                }
              : rootlessSnapshot,
            options.omitSnapshotBackend === true,
          ),
        };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([
      { name: 'default', snapshot: options.sessionSnapshot ?? presented },
    ]),
    policy: localCommandPolicy(),
    clock,
  });
  return { runtime };
}

function withoutSnapshotBackend(snapshot: SnapshotState, omit: boolean): SnapshotState {
  if (!omit) return snapshot;
  const { backend: _backend, producer: _producer, ...backendless } = snapshot;
  return backendless;
}

function withCaptureBackend(
  snapshot: SnapshotState,
  backend: 'tree' | 'private-ax',
): SnapshotState {
  return {
    ...snapshot,
    snapshotQuality:
      backend === 'tree'
        ? snapshot.snapshotQuality
        : ({ state: 'recovered', backend: 'private-ax' } as const),
  };
}
