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
  elementSettingsSnapshot,
  elementSettledRoomSnapshot,
  elementThreadsNoticeSnapshot,
  elementTransientRoomSnapshot,
} from './stable-capture.fixtures.ts';
import { createMemorySessionStore } from '../../../command-runtime/runtime-factory.ts';

const BROAD_TRANSITION_PARAMS = {
  quietMs: 500,
  timeoutMs: 5_000,
  broadTransitionBaselineNodes: elementThreadsNoticeSnapshot.nodes,
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
        broadTransitionBaselineNodes: elementThreadsNoticeSnapshot.nodes.slice(1),
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
      broadTransitionBaselineNodes: elementThreadsNoticeSnapshot.nodes.slice(1),
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

test('settle keeps the default quiet window for a larger partial projection', async () => {
  const { runtime } = transitionRuntime({ omitViewportRoot: true, settledAtMs: 1_200 });

  const outcome = await runStableCaptureLoop(
    runtime,
    { session: 'default' },
    {
      ...BROAD_TRANSITION_PARAMS,
      broadTransitionBaselineNodes: elementSettingsSnapshot([1_138, 1_423, 2_144, 2_434]).nodes,
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
      broadTransitionBaselineNodes: elementSettledRoomSnapshot.nodes,
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
      broadTransitionBaselineNodes: keyboardUp.nodes.filter((node) => node.index <= 30),
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
  } = {},
) {
  const captureBackend = options.captureBackend ?? 'tree';
  const settledAtMs = options.settledAtMs ?? 800;
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
        const snapshot = keepsBaseline
          ? elementThreadsNoticeSnapshot
          : withCaptureBackend(
              elapsedMs < settledAtMs ? elementTransientRoomSnapshot : elementSettledRoomSnapshot,
              captureBackend,
            );
        return {
          snapshot: withoutSnapshotBackend(
            options.omitViewportRoot === true
              ? { ...snapshot, nodes: snapshot.nodes.slice(1) }
              : snapshot,
            options.omitSnapshotBackend === true,
          ),
        };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([
      { name: 'default', snapshot: options.sessionSnapshot ?? elementThreadsNoticeSnapshot },
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
