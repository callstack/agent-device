import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import type { AgentDeviceBackend } from '../../../backend.ts';
import { createLocalArtifactAdapter } from '../../../io.ts';
import {
  createAgentDevice,
  createMemorySessionStore,
  localCommandPolicy,
} from '../../../runtime.ts';
import { runStableCaptureLoop } from './stable-capture.ts';
import {
  elementSettingsSnapshot,
  elementSettledRoomSnapshot,
  elementThreadsNoticeSnapshot,
  elementTransientRoomSnapshot,
} from './stable-capture.fixtures.ts';

const BROAD_TRANSITION_PARAMS = {
  quietMs: 500,
  timeoutMs: 5_000,
  broadTransitionBaselineNodes: elementThreadsNoticeSnapshot.nodes,
};

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
    sessionSnapshot: { ...elementTransientRoomSnapshot, backend: undefined },
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

test('settle honors an explicitly shorter quiet window across a broad replacement', async () => {
  const { runtime } = transitionRuntime();

  const outcome = await runStableCaptureLoop(
    runtime,
    { session: 'default' },
    { ...BROAD_TRANSITION_PARAMS, quietMs: 25 },
  );

  assert.equal(outcome.settled, true);
  assert.ok(outcome.captures <= 3, `short quiet window spent ${outcome.captures} captures`);
  assert.ok(outcome.waitedMs < 800, `short quiet window settled after ${outcome.waitedMs}ms`);
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
  const { backend: _backend, ...backendless } = snapshot;
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
