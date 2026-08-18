import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend } from '../../../backend.ts';
import { createLocalArtifactAdapter } from '../../../io.ts';
import {
  createAgentDevice,
  createMemorySessionStore,
  localCommandPolicy,
} from '../../../runtime.ts';
import { runStableCaptureLoop } from './stable-capture.ts';
import { elementSettingsSnapshot } from './stable-capture.fixtures.ts';

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
