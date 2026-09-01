import { expect, test, vi } from 'vitest';
import { captureSnapshot, captureSnapshotData } from '../snapshot-capture.ts';
import { buildSnapshotVisibility } from '../../../snapshot/snapshot-visibility.ts';
import { attachSnapshotPresentationEvidence } from '@agent-device/contracts/capture';
import {
  ANDROID_EMULATOR,
  IOS_SIMULATOR,
  MACOS_DEVICE,
} from '../../../__tests__/test-utils/device-fixtures.ts';

const captureSnapshotWithInteractor = vi.hoisted(() => vi.fn());
const iosPresentation = vi.hoisted(() => vi.fn());
vi.mock('../snapshot-interactor-capture.ts', () => ({ captureSnapshotWithInteractor }));
vi.mock('@agent-device/capture-kit/ios-snapshot-engine', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/capture-kit/ios-snapshot-engine')>();
  iosPresentation.mockImplementation(actual.presentIosInteractiveSnapshot);
  return { ...actual, presentIosInteractiveSnapshot: iosPresentation };
});

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

test('daemon does not re-present provider results already presented by the shared engine', async () => {
  iosPresentation.mockClear();
  const providerResult = attachSnapshotPresentationEvidence(
    {
      nodes: [{ index: 0, depth: 0, type: 'Application' }],
      backend: 'xctest' as const,
      producer: 'limrun-ios-tree' as const,
    },
    { owner: 'ios-snapshot-engine' },
  );

  const result = await captureSnapshot({
    device: IOS_SIMULATOR,
    session: undefined,
    flags: { snapshotInteractiveOnly: true },
    logPath: '/tmp/snapshot-capture-test.log',
    captureData: async () => providerResult,
  });

  expect(iosPresentation).not.toHaveBeenCalled();
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
