import { afterEach, expect, test, vi } from 'vitest';
import {
  readSnapshotClickabilityEvidence,
  readSnapshotOcclusionContextEvidence,
} from '@agent-device/contracts/capture';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createAndroidInteractor } from './android.ts';
import {
  fillAndroid,
  scrollAndroid,
  snapshotAndroid,
} from '@agent-device/platform-android/mechanics';
import { makeAndroidSnapshotCapture } from '../../__tests__/test-utils/android-snapshot-capture.ts';

vi.mock('@agent-device/platform-android/mechanics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-android/mechanics')>();
  return {
    ...actual,
    snapshotAndroid: vi.fn(),
    scrollAndroid: vi.fn(),
    fillAndroid: vi.fn(),
    typeAndroid: vi.fn(),
  };
});

const snapshotAndroidMock = vi.mocked(snapshotAndroid);
const fillAndroidMock = vi.mocked(fillAndroid);
const scrollAndroidMock = vi.mocked(scrollAndroid);
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
