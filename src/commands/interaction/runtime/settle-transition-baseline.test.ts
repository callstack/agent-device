import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend } from '../../../backend.ts';
import { createLocalArtifactAdapter } from '../../../io.ts';
import {
  createAgentDevice,
  createMemorySessionStore,
  localCommandPolicy,
} from '../../../runtime.ts';
import {
  elementSettledRoomSnapshot,
  elementThreadsNoticeSnapshot,
  elementTransientRoomSnapshot,
} from './stable-capture.fixtures.ts';
import { settleAfterInteraction } from './settle.ts';

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
    outcome.settledNodes?.some((node) => node.label === 'action file'),
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
        preActionNodes: elementTransientRoomSnapshot.nodes,
      },
      quietMs: 500,
      timeoutMs: 5_000,
    },
  );

  assert.equal(outcome.observation.settled, true);
  assert.equal(
    outcome.settledNodes?.some((node) => node.label === 'action file'),
    false,
  );
  assert.ok(
    outcome.observation.waitedMs >= 1_500,
    `settled against polluted evidence after ${outcome.observation.waitedMs}ms`,
  );
});
