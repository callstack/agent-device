import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend } from '@agent-device/contracts/backend';
import { createLocalArtifactAdapter } from '../../../io.ts';
import { createAgentDevice } from '../../../runtime.ts';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import {
  elementSettledRoomSnapshot,
  elementThreadsNoticeSnapshot,
  elementTransientRoomSnapshot,
} from './stable-capture.fixtures.ts';
import { settleAfterInteraction } from './settle.ts';
import { createMemorySessionStore } from '../../../command-runtime/runtime-factory.ts';

test('settle recovers the session baseline when resolved target evidence is absent', async () => {
  let elapsedMs = 0;
  const runtime = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => ({
        snapshot: elapsedMs < 1_200 ? elementTransientRoomSnapshot : elementSettledRoomSnapshot,
      }),
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([
      {
        name: 'default',
        snapshot: elementThreadsNoticeSnapshot,
        refFrameSnapshot: elementThreadsNoticeSnapshot,
      },
    ]),
    policy: localCommandPolicy(),
    clock: {
      now: () => elapsedMs,
      sleep: async (ms: number) => {
        elapsedMs += ms;
      },
    },
  });

  const outcome = await settleAfterInteraction(
    runtime,
    { session: 'default' },
    {
      resolved: {
        kind: 'ref',
        point: { x: 201, y: 795 },
        target: { kind: 'ref', ref: '@e5' },
      },
      quietMs: 500,
      timeoutMs: 5_000,
    },
  );

  assert.equal(outcome.observation.settled, true);
  assert.equal(
    outcome.settledCapture?.nodes.some((node) => node.label === 'action file'),
    false,
  );
  assert.ok(
    outcome.observation.waitedMs >= 1_500,
    `settled without recovered baseline after ${outcome.observation.waitedMs}ms`,
  );
});

test('settle uses the authorized ref frame instead of a polluted evidence capture', async () => {
  let elapsedMs = 0;
  const runtime = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => ({
        snapshot: elapsedMs < 1_200 ? elementTransientRoomSnapshot : elementSettledRoomSnapshot,
      }),
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([
      {
        name: 'default',
        snapshot: elementThreadsNoticeSnapshot,
        refFrameSnapshot: elementThreadsNoticeSnapshot,
      },
    ]),
    policy: localCommandPolicy(),
    clock: {
      now: () => elapsedMs,
      sleep: async (ms: number) => {
        elapsedMs += ms;
      },
    },
  });

  const outcome = await settleAfterInteraction(
    runtime,
    { session: 'default' },
    {
      resolved: {
        kind: 'ref',
        point: { x: 201, y: 795 },
        target: { kind: 'ref', ref: '@e5' },
        preAction: { nodes: elementTransientRoomSnapshot.nodes },
      },
      quietMs: 500,
      timeoutMs: 5_000,
    },
  );

  assert.equal(outcome.observation.settled, true);
  assert.equal(
    outcome.settledCapture?.nodes.some((node) => node.label === 'action file'),
    false,
  );
  assert.ok(
    outcome.observation.waitedMs >= 1_500,
    `settled against polluted evidence after ${outcome.observation.waitedMs}ms`,
  );
});

// The point-target chain (`kind: 'point'`, no pre-action evidence) falls to
// sessionBaseline, which prefers the session's ref frame over the operational
// snapshot and only yields the empty baseline for a pre-frame session. The
// branch chosen decides what the settled diff reports as removed.
async function settlePointTargetAgainstSession(session: {
  name: string;
  refFrameSnapshot?: typeof elementThreadsNoticeSnapshot;
  snapshot?: typeof elementThreadsNoticeSnapshot;
}) {
  let elapsedMs = 0;
  const runtime = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => ({
        snapshot: elapsedMs < 1_200 ? elementTransientRoomSnapshot : elementSettledRoomSnapshot,
      }),
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([session]),
    policy: localCommandPolicy(),
    clock: {
      now: () => elapsedMs,
      sleep: async (ms: number) => {
        elapsedMs += ms;
      },
    },
  });

  const outcome = await settleAfterInteraction(
    runtime,
    { session: 'default' },
    {
      // A tap at the transient room's title field: the branch under test only
      // runs for a non-ref resolution with no pre-action evidence.
      resolved: { kind: 'point', point: { x: 100, y: 67 } },
      quietMs: 500,
      timeoutMs: 5_000,
    },
  );
  const diff = outcome.observation.diff;
  assert.ok(diff, `expected a settled diff: ${outcome.observation.hint ?? 'no hint'}`);
  return {
    removed: diff.lines.filter((line) => line.kind === 'removed').map((line) => line.text),
  };
}

test('point-target settle prefers the session ref frame over the operational snapshot', async () => {
  const { removed } = await settlePointTargetAgainstSession({
    name: 'default',
    refFrameSnapshot: elementThreadsNoticeSnapshot,
    snapshot: elementTransientRoomSnapshot,
  });
  assert.ok(
    removed.some((text) => text.includes('Threads no longer experimental')),
    `ref frame should be the baseline: ${removed.join(' | ')}`,
  );
  assert.ok(
    !removed.some((text) => text.includes('Weekend Plans')),
    `operational snapshot leaked into the baseline: ${removed.join(' | ')}`,
  );
});

test('point-target settle falls back to the session snapshot without a ref frame', async () => {
  const { removed } = await settlePointTargetAgainstSession({
    name: 'default',
    snapshot: elementThreadsNoticeSnapshot,
  });
  assert.ok(
    removed.some((text) => text.includes('Threads no longer experimental')),
    `session snapshot should be the baseline: ${removed.join(' | ')}`,
  );
});

test('point-target settle diffs from an empty baseline for a pre-frame session', async () => {
  const { removed } = await settlePointTargetAgainstSession({ name: 'default' });
  assert.deepEqual(removed, []);
});
