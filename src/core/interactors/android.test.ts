import { afterEach, expect, test, vi } from 'vitest';
import {
  readSnapshotClickabilityEvidence,
  readSnapshotOcclusionContextEvidence,
} from '@agent-device/contracts/capture';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createAndroidInteractor } from './android.ts';
import {
  fillAndroid,
  openAndroidApp,
  scrollAndroid,
  snapshotAndroid,
} from '@agent-device/platform-android/mechanics';
import { makeAndroidSnapshotCapture } from '@agent-device/platform-android/snapshot-capture-fixtures';

vi.mock('@agent-device/platform-android/mechanics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-android/mechanics')>();
  return {
    ...actual,
    snapshotAndroid: vi.fn(),
    scrollAndroid: vi.fn(),
    fillAndroid: vi.fn(),
    openAndroidApp: vi.fn(),
    typeAndroid: vi.fn(),
  };
});

const snapshotAndroidMock = vi.mocked(snapshotAndroid);
const fillAndroidMock = vi.mocked(fillAndroid);
const scrollAndroidMock = vi.mocked(scrollAndroid);
const openAndroidAppMock = vi.mocked(openAndroidApp);
const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

afterEach(() => {
  vi.resetAllMocks();
});

test('preserves Android clickability evidence through the interactor snapshot adapter', async () => {
  const nodes = [{ index: 0, identifier: 'target', rect: { x: 0, y: 0, width: 20, height: 20 } }];
  const evidence = {
    kind: 'exact' as const,
    provider: 'android-helper' as const,
    clickableByNodeIndex: new Map<number, boolean | undefined>([[0, true]]),
  };
  const occlusionContext = {
    nodes,
    sourceIndexByNodeIndex: new Map([[0, 0]]),
  };
  const captured = makeAndroidSnapshotCapture(nodes, {
    clickability: evidence,
    occlusionContext,
  });
  snapshotAndroidMock.mockResolvedValue(captured);

  const result = await createAndroidInteractor(device).snapshot({});

  if ('stage' in result) throw new Error('Android snapshot must be presented');
  expect(readSnapshotClickabilityEvidence(result)).toEqual(evidence);
  expect(readSnapshotOcclusionContextEvidence(result)).toEqual(occlusionContext);
  expect(result.quality).toEqual({ state: 'healthy', backend: 'android-helper' });
  expect(JSON.stringify(result)).not.toContain('clickable');
});

test('an app-backed session keeps the helper warm across fill and scroll', async () => {
  const interactor = createAndroidInteractor(device, undefined, {
    appBundleId: 'com.example.app',
  });

  await interactor.fill(10, 20, 'chips');
  await interactor.scroll('down', { amount: 1 });

  expect(fillAndroidMock).toHaveBeenCalledWith(device, 10, 20, 'chips', undefined, {
    helperSessionScope: 'daemon-session',
  });
  expect(scrollAndroidMock).toHaveBeenCalledWith(device, 'down', {
    amount: 1,
    helperSessionScope: 'daemon-session',
  });
});

test('a device-only session releases the helper after fill and scroll', async () => {
  const interactor = createAndroidInteractor(device);

  await interactor.fill(10, 20, 'chips');
  await interactor.scroll('down');

  expect(fillAndroidMock).toHaveBeenCalledWith(device, 10, 20, 'chips', undefined, {
    helperSessionScope: 'command',
  });
  expect(scrollAndroidMock).toHaveBeenCalledWith(device, 'down', {
    helperSessionScope: 'command',
  });
});

test('alert reads ride the session-scope helper, not a per-probe cold start', async () => {
  // The executed Android smoke failure: an alert probe without the session scope cold-started
  // the snapshot helper inside the window that bounds the probe, so the post-press confirm read
  // was aborted before the device answered. Alert captures scope like every other read.
  snapshotAndroidMock.mockResolvedValue(makeAndroidSnapshotCapture([]));
  const interactor = createAndroidInteractor(device, undefined, {
    appBundleId: 'com.example.app',
  });

  if (!interactor.readAlert) throw new Error('Android interactor must expose readAlert');
  await interactor.readAlert();

  const options = snapshotAndroidMock.mock.lastCall?.[1];
  expect(options?.helperSessionScope).toBe('daemon-session');
});

test('a transient snapshot reaches the Android capture with its settle deadline', async () => {
  snapshotAndroidMock.mockResolvedValue(makeAndroidSnapshotCapture([]));

  await createAndroidInteractor(device).snapshot({
    appBundleId: 'com.example.app',
    transient: { settleBy: 1_000 },
  });

  expect(snapshotAndroidMock).toHaveBeenCalledWith(
    device,
    expect.objectContaining({
      appBundleId: 'com.example.app',
      transient: { settleBy: 1_000 },
    }),
  );
});

test('a relaunching open asks the Android launch to terminate the running app', async () => {
  await createAndroidInteractor(device).open('settings', { terminateRunningApp: true });

  expect(openAndroidAppMock).toHaveBeenCalledWith(
    device,
    'settings',
    expect.objectContaining({ terminateRunningApp: true }),
  );
});
