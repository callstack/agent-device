import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend, BackendSnapshotOptions } from '@agent-device/contracts/backend';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { createLocalArtifactAdapter } from '../../../io.ts';
import { createAgentDevice } from '../../../runtime.ts';
import { createFakeClock } from './__tests__/test-utils/index.ts';

const LOCATION_REQUIRED = makeSnapshotState(
  [
    { index: 0, depth: 0, type: 'android.widget.TextView', label: 'Location required' },
    { index: 1, depth: 0, type: 'android.widget.Button', label: 'Dismiss' },
  ],
  { backend: 'android' },
);

const BATTERY = makeSnapshotState(
  [{ index: 0, depth: 0, type: 'android.widget.TextView', label: 'Battery' }],
  { backend: 'android' },
);

function pollingDevice(captureOptions: Array<BackendSnapshotOptions | undefined>) {
  const backend: AgentDeviceBackend = {
    platform: 'android',
    captureSnapshot: async (_context, options) => {
      captureOptions.push(options);
      return { snapshot: captureOptions.length === 1 ? LOCATION_REQUIRED : BATTERY };
    },
  };
  return createAgentDevice({
    backend,
    artifacts: createLocalArtifactAdapter(),
    sessions: { get: () => undefined, set: () => {} },
    policy: localCommandPolicy(),
    clock: createFakeClock(),
  });
}

test.each([
  { name: 'text', target: { kind: 'text', text: 'Battery', timeoutMs: 8000 } },
  { name: 'selector', target: { kind: 'selector', selector: 'label="Battery"', timeoutMs: 8000 } },
] as const)(
  'a $name wait skips hidden-content hint derivation on every poll (#1270)',
  async ({ target }) => {
    const captureOptions: Array<BackendSnapshotOptions | undefined> = [];
    const device = pollingDevice(captureOptions);

    await device.selectors.wait({ session: 'default', target });

    assert.equal(captureOptions.length, 2);
    for (const options of captureOptions) {
      assert.equal(options?.includeHiddenContentHints, false);
    }
  },
);
