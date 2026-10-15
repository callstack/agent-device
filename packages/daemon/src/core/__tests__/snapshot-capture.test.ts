import { expect, test, vi } from 'vitest';
import { captureSnapshot, captureSnapshotData } from '../snapshot-capture.ts';
import { buildSnapshotVisibility } from '@agent-device/capture-kit/snapshot-visibility';
import { ANDROID_EMULATOR, buildNodes, IOS_SIMULATOR, MACOS_DEVICE } from '@agent-device/test-kit';
import {
  legacyDispatchCapture,
  resetLegacySnapshotCapture,
} from '../../__tests__/support/legacy-snapshot-capture-fixture.ts';
import {
  androidCapture,
  androidDevice,
  androidTextRows,
  inboxBaselineNodes,
  inboxRow,
  makeAndroidFreshnessSession,
} from '../../__tests__/support/handlers/snapshot-handler.fixtures.ts';
import { pendingSurfaceStabilization } from '../deferred-interaction-outcome.ts';

const captureSnapshotWithInteractor = vi.hoisted(() => vi.fn());
vi.mock('../snapshot-interactor-capture.ts', () => ({ captureSnapshotWithInteractor }));

test('iOS interactive capture sends scope to runner presentation', async () => {
  captureSnapshotWithInteractor.mockClear();
  captureSnapshotWithInteractor.mockResolvedValueOnce({ nodes: [], backend: 'xctest' });

  await captureSnapshotData({
    device: IOS_SIMULATOR,
    session: undefined,
    flags: { snapshotInteractiveOnly: true, snapshotScope: 'action file' },
    snapshotScope: 'action file',
    logPath: '/tmp/snapshot-capture-test.log',
  });

  expect(captureSnapshotWithInteractor).toHaveBeenCalledOnce();
  expect(captureSnapshotWithInteractor).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({ interactiveOnly: true, scope: 'action file' }),
    }),
  );
});

test('snapshot capture preserves scope for every other platform projection', async () => {
  captureSnapshotWithInteractor.mockClear();
  for (const [device, flags] of [
    [ANDROID_EMULATOR, { snapshotInteractiveOnly: true, snapshotScope: 'action file' }],
    [
      IOS_SIMULATOR,
      { snapshotInteractiveOnly: true, snapshotRaw: true, snapshotScope: 'action file' },
    ],
    [MACOS_DEVICE, { snapshotInteractiveOnly: true, snapshotScope: 'action file' }],
  ] as const) {
    captureSnapshotWithInteractor.mockResolvedValueOnce({ nodes: [] });
    await captureSnapshotData({
      device,
      session: undefined,
      flags,
      snapshotScope: 'action file',
      logPath: '/tmp/snapshot-capture-test.log',
    });
  }

  expect(captureSnapshotWithInteractor.mock.calls.map((call) => call[0]?.options.scope)).toEqual([
    'action file',
    'action file',
    'action file',
  ]);
});

test('buildSnapshotVisibility returns non-partial for empty node list', () => {
  const vis = buildSnapshotVisibility({ nodes: [], backend: 'android' });
  expect(vis.partial).toBe(false);
  expect(vis.visibleNodeCount).toBe(0);
  expect(vis.totalNodeCount).toBe(0);
  expect(vis.reasons).toEqual([]);
});

test('buildSnapshotVisibility detects scroll-hidden-above and scroll-hidden-below', () => {
  const nodes = [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'ScrollView',
      label: 'Feed',
      hiddenContentAbove: true,
      hiddenContentBelow: true,
    },
  ];
  const vis = buildSnapshotVisibility({ nodes, backend: 'android' });
  expect(vis.partial).toBe(true);
  expect(vis.reasons).toContain('scroll-hidden-above');
  expect(vis.reasons).toContain('scroll-hidden-below');
});

test('buildSnapshotVisibility handles nodes with no scroll hints as non-partial', () => {
  const nodes = [
    { ref: 'e1', index: 0, depth: 0, type: 'Button', label: 'OK', hittable: true },
    { ref: 'e2', index: 1, depth: 0, type: 'Button', label: 'Cancel', hittable: true },
  ];
  const vis = buildSnapshotVisibility({ nodes, backend: 'xctest' });
  expect(vis.partial).toBe(false);
  expect(vis.visibleNodeCount).toBe(2);
  expect(vis.totalNodeCount).toBe(2);
  expect(vis.reasons).toEqual([]);
});

test('captureSnapshot composes post-gesture stabilization with Android freshness capture', async () => {
  resetLegacySnapshotCapture(captureSnapshotWithInteractor);
  const sessionName = 'android-post-gesture-freshness';
  const baselineNodes = inboxBaselineNodes(18);
  const changedNodes = buildNodes(
    androidTextRows(18, (row) => (row === 1 ? 'album-0' : `Album row ${row}`)),
  );
  const session = makeAndroidFreshnessSession(sessionName, 'click', baselineNodes);
  session.deferredSurface = {
    kind: 'stabilize',
    action: 'click',
    positionals: [],
    markedAt: Date.now(),
  };

  legacyDispatchCapture
    .mockResolvedValueOnce(androidCapture(baselineNodes, { rawNodeCount: 18, maxDepth: 1 }))
    .mockResolvedValueOnce(androidCapture(changedNodes, { rawNodeCount: 18, maxDepth: 1 }))
    .mockResolvedValueOnce(androidCapture(changedNodes, { rawNodeCount: 18, maxDepth: 1 }));

  vi.useFakeTimers();
  let result: Awaited<ReturnType<typeof captureSnapshot>>;
  try {
    const pending = captureSnapshot({
      device: androidDevice,
      session,
      flags: { snapshotInteractiveOnly: true },
      logPath: '/tmp/daemon.log',
    });
    await vi.advanceTimersByTimeAsync(10_000);
    result = await pending;
  } finally {
    vi.useRealTimers();
  }

  expect(result.snapshot.nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: 'album-0' })]),
  );
  expect(legacyDispatchCapture.mock.calls.map((call) => call[1])).toEqual([
    'snapshot',
    'snapshot',
    'snapshot',
  ]);
  expect(session.androidSnapshotFreshness).toBeUndefined();
  expect(pendingSurfaceStabilization(session)).toBeUndefined();
});

test('captureSnapshot retries a stale Android tree after recent navigation until the tree changes', async () => {
  resetLegacySnapshotCapture(captureSnapshotWithInteractor);
  const session = makeAndroidFreshnessSession(
    'android-stale-retry',
    'press',
    inboxBaselineNodes(24),
  );
  legacyDispatchCapture
    .mockResolvedValueOnce(
      androidCapture(androidTextRows(24, inboxRow), { rawNodeCount: 24, maxDepth: 2 }),
    )
    .mockResolvedValueOnce(
      androidCapture(
        [
          { index: 0, depth: 0, type: 'android.widget.TextView', label: 'Create document' },
          { index: 1, depth: 0, type: 'android.widget.Button', label: 'Submit', hittable: true },
        ],
        { rawNodeCount: 2, maxDepth: 1 },
      ),
    );

  const result = await captureSnapshot({
    device: androidDevice,
    session,
    flags: { snapshotInteractiveOnly: true },
    logPath: '/tmp/daemon.log',
  });

  expect(result.snapshot.nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: 'Create document' })]),
  );
  expect(legacyDispatchCapture).toHaveBeenCalledTimes(2);
  expect(session.androidSnapshotFreshness).toBeUndefined();
});

test('Android ref refresh mode does not retry narrow snapshots as sharp drops', async () => {
  resetLegacySnapshotCapture(captureSnapshotWithInteractor);
  const session = makeAndroidFreshnessSession(
    'android-ref-refresh-no-sharp-drop',
    'press',
    buildNodes(androidTextRows(50, (row) => `Previous row ${row}`)),
  );
  legacyDispatchCapture.mockResolvedValue(
    androidCapture(
      Array.from({ length: 8 }, (_, index) => ({
        index,
        depth: 0,
        type: 'android.widget.TextView',
      })),
      { rawNodeCount: 8, maxDepth: 1 },
    ),
  );

  const result = await captureSnapshot({
    device: androidDevice,
    session,
    flags: { snapshotInteractiveOnly: true },
    logPath: '/tmp/daemon.log',
    androidFreshnessMode: 'ref-refresh',
  });

  expect(result.freshness).toBeUndefined();
  expect(legacyDispatchCapture).toHaveBeenCalledTimes(1);
  expect(session.androidSnapshotFreshness).toBeUndefined();
});
