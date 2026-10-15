import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend, BackendSnapshotResult } from '@agent-device/contracts/backend';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import { buildSnapshotPresentationKey } from '@agent-device/kernel/snapshot';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { createLocalArtifactAdapter } from '../../../io.ts';
import { createAgentDevice } from '../../../runtime.ts';

function snapshotDevice(
  result: BackendSnapshotResult,
  session?: { name: string; snapshot: ReturnType<typeof makeSnapshotState> },
) {
  const backend: AgentDeviceBackend = {
    platform: 'android',
    captureSnapshot: async () => result,
  };
  return createAgentDevice({
    backend,
    artifacts: createLocalArtifactAdapter(),
    sessions: { get: () => session, set: () => {} },
    policy: localCommandPolicy(),
    clock: { now: () => 1_500, sleep: async () => {} },
  });
}

const STUCK_ROUTE_WARNING =
  'Recent press was followed by a nearly identical snapshot after 3 automatic retries. If you expected navigation or submit, the tree may still be stale. Use screenshot as visual truth, wait briefly, then re-snapshot once.';

const ANDROID_ROWS = Array.from({ length: 24 }, (_, index) => ({
  ref: `e${index + 1}`,
  index,
  depth: 0,
  type: 'android.widget.TextView',
  label: `Inbox row ${index + 1}`,
}));

test('runtime snapshot warns when Android freshness retries still return the previous route', async () => {
  const device = snapshotDevice({
    nodes: ANDROID_ROWS,
    truncated: false,
    backend: 'android',
    freshness: {
      action: 'press',
      retryCount: 3,
      staleAfterRetries: true,
      reason: 'stuck-route',
    },
  });

  const result = await device.capture.snapshot({ session: 'default', interactiveOnly: true });

  assert.deepEqual(result.warnings, [STUCK_ROUTE_WARNING]);
});

test('runtime diff snapshot carries the stale-route warning for recent Android presses', async () => {
  const baseline = makeSnapshotState(ANDROID_ROWS, { backend: 'android' });
  baseline.createdAt = 1_000;
  const device = snapshotDevice(
    {
      nodes: ANDROID_ROWS,
      truncated: false,
      backend: 'android',
      freshness: {
        action: 'press',
        retryCount: 3,
        staleAfterRetries: true,
        reason: 'stuck-route',
      },
    },
    { name: 'default', snapshot: baseline },
  );

  const result = await device.capture.diffSnapshot({ session: 'default', interactiveOnly: true });

  assert.deepEqual(result.warnings, [STUCK_ROUTE_WARNING]);
});

test('runtime snapshot raises no stale-route warning once the freshness retries succeeded', async () => {
  const device = snapshotDevice({
    nodes: ANDROID_ROWS,
    truncated: false,
    backend: 'android',
    freshness: { action: 'press', retryCount: 1, staleAfterRetries: false },
  });

  const result = await device.capture.snapshot({ session: 'default', interactiveOnly: true });

  assert.equal(result.warnings, undefined);
});

test.each([
  { name: 'does not warn on an expected node drop across presentation modes', interactive: false },
  { name: 'warns on a sharp node drop within one presentation mode', interactive: true },
])('runtime snapshot $name', async ({ interactive }) => {
  const previous = makeSnapshotState(
    Array.from({ length: 50 }, (_, index) => ({
      index,
      depth: 0,
      type: 'android.widget.TextView',
      label: `Row ${index + 1}`,
    })),
    { backend: 'android' },
  );
  previous.createdAt = 1_000;
  previous.presentationKey = buildSnapshotPresentationKey({ interactiveOnly: interactive });
  const device = snapshotDevice(
    {
      nodes: Array.from({ length: 8 }, (_, index) => ({
        ref: `e${index + 1}`,
        index,
        depth: 0,
        type: 'android.widget.Button',
        label: `Action ${index + 1}`,
        hittable: true,
      })),
      truncated: false,
      backend: 'android',
    },
    { name: 'default', snapshot: previous },
  );

  const result = await device.capture.snapshot({ session: 'default', interactiveOnly: true });

  assert.equal(
    result.warnings?.some((warning) => /Recent snapshots dropped sharply/.test(warning)) ?? false,
    interactive,
  );
});

test('runtime snapshot reports normalized visibility metadata for scroll-hidden content', async () => {
  const device = snapshotDevice({
    nodes: [
      {
        ref: 'e1',
        index: 0,
        depth: 0,
        type: 'android.widget.ScrollView',
        label: 'Messages',
        rect: { x: 0, y: 100, width: 390, height: 500 },
        hiddenContentBelow: true,
      },
      {
        ref: 'e2',
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'android.widget.Button',
        label: 'Visible message',
        rect: { x: 0, y: 140, width: 390, height: 48 },
        hittable: true,
      },
    ],
    truncated: false,
    backend: 'android',
    analysis: { rawNodeCount: 2, maxDepth: 1 },
  });

  const result = await device.capture.snapshot({ session: 'default', interactiveOnly: true });

  assert.deepEqual(result.visibility, {
    partial: true,
    visibleNodeCount: 2,
    totalNodeCount: 2,
    reasons: ['scroll-hidden-below'],
  });
});
