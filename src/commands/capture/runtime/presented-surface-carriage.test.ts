import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend, BackendSnapshotResult } from '@agent-device/contracts/backend';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import type {
  CommandSessionRecord,
  CommandSessionStore,
} from '@agent-device/contracts/runtime-contract';
import { createLocalArtifactAdapter } from '../../../io.ts';
import { createAgentDevice } from '../../../runtime.ts';

/**
 * #3565: the presented-surface fact a capture producer publishes has to reach both places a consumer
 * reads it from — the response an operator inspects, and the session record the next settle and the
 * next interaction mint their baseline from. The capture route copies a declared field set, so a
 * field that is not copied disappears here and shows up later as a dismissal confirmation nobody can
 * confirm. A backend states the fact inside the state it returns.
 */
for (const presentedSurface of ['presented', 'absent', 'unknown'] as const) {
  test(`runtime capture carries a ${presentedSurface} presented surface stated inside backend state`, async () => {
    const captured = await captureWith({
      snapshot: {
        nodes: [{ ref: 'e1', index: 0, depth: 0, type: 'Window', label: 'Home' }],
        truncated: false,
        backend: 'xctest',
        createdAt: 1,
        presentedSurface,
      },
    });

    assert.equal(captured.response.presentedSurface, presentedSurface, 'response');
    assert.equal(captured.recorded?.snapshot?.presentedSurface, presentedSurface, 'session record');
  });
}

/** A producer that states nothing must stay silent, never become a false absence. */
test('runtime capture keeps an unstated presented surface unstated', async () => {
  const insideState = await captureWith({
    snapshot: {
      nodes: [{ ref: 'e1', index: 0, depth: 0, type: 'Window', label: 'Home' }],
      truncated: false,
      backend: 'xctest',
      createdAt: 1,
    },
  });
  assert.equal('presentedSurface' in insideState.response, false, 'response');
  assert.equal(insideState.recorded?.snapshot?.presentedSurface, undefined, 'session record');
});

async function captureWith(result: BackendSnapshotResult) {
  let recorded: CommandSessionRecord | undefined;
  const sessions: CommandSessionStore = {
    get: () => undefined,
    set: (value) => {
      recorded = value;
    },
  };
  const backend: AgentDeviceBackend = {
    platform: 'ios',
    captureSnapshot: async () => result,
  };
  const device = createAgentDevice({
    backend,
    artifacts: createLocalArtifactAdapter(),
    sessions,
    policy: localCommandPolicy(),
  });

  const response = await device.capture.snapshot({ session: 'default' });
  return { response, recorded };
}
