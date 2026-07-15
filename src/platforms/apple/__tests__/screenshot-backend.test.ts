import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '../../../kernel/device.ts';

vi.mock('../core/screenshot.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/screenshot.ts')>();
  return {
    ...actual,
    captureScreenshotViaRunner: vi.fn(),
    screenshotIos: vi.fn(),
  };
});

import { createAppleInteractor } from '../interactor.ts';
import { captureScreenshotViaRunner, screenshotIos } from '../core/screenshot.ts';

const device: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'simulator-1',
  name: 'iPhone',
  kind: 'simulator',
  booted: true,
};

beforeEach(() => {
  vi.mocked(captureScreenshotViaRunner).mockReset();
  vi.mocked(screenshotIos).mockReset();
});

test('routes an internal runner screenshot without changing the default backend', async () => {
  const interactor = createAppleInteractor(device, { appBundleId: 'com.example.app' });

  await interactor.screenshot('/tmp/default.png');
  await interactor.screenshot('/tmp/runner.png', {
    appBundleId: 'com.example.app',
    captureBackend: 'runner',
  });

  expect(screenshotIos).toHaveBeenCalledOnce();
  expect(screenshotIos).toHaveBeenCalledWith(
    device,
    '/tmp/default.png',
    expect.objectContaining({ appBundleId: undefined }),
  );
  expect(captureScreenshotViaRunner).toHaveBeenCalledOnce();
  expect(captureScreenshotViaRunner).toHaveBeenCalledWith(
    device,
    '/tmp/runner.png',
    'com.example.app',
    undefined,
    expect.objectContaining({}),
  );
});
