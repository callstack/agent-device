import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

vi.mock('../core/screenshot.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/screenshot.ts')>();
  return {
    ...actual,
    captureScreenshotViaRunner: vi.fn(),
    screenshotIos: vi.fn(),
  };
});

vi.mock('../os/macos/helper.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../os/macos/helper.ts')>()),
  runMacOsScreenshotAction: vi.fn(),
}));

import { createAppleInteractor } from '../interactor.ts';
import { runMacOsScreenshotAction } from '../os/macos/helper.ts';
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
  const interactor = createAppleInteractor(
    device,
    { appBundleId: 'com.example.app' },
    { env: process.env, cwd: process.cwd() },
  );

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
    process.env,
  );
});

test('forwards the request mask and refuses an explicit runner capture with it', async () => {
  const interactor = createAppleInteractor(device, {}, { env: {}, cwd: process.cwd() });
  await interactor.screenshot('/tmp/masked.png', { screenMask: 'black' });
  expect(screenshotIos).toHaveBeenCalledWith(
    device,
    '/tmp/masked.png',
    expect.objectContaining({ screenMask: 'black' }),
  );
  await expect(
    interactor.screenshot('/tmp/runner.png', { screenMask: 'black', captureBackend: 'runner' }),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'screenshot-screen-mask-unsupported' },
  });
  expect(captureScreenshotViaRunner).not.toHaveBeenCalled();
});

test.each([
  { ...device, kind: 'device' as const },
  { ...device, appleOs: 'macos' as const, kind: 'device' as const, target: 'desktop' as const },
])('direct Apple $appleOs $kind captures refuse masks before native execution', async (target) => {
  const interactor = createAppleInteractor(target, {}, { env: {}, cwd: process.cwd() });
  await expect(
    interactor.screenshot('/tmp/masked.png', { screenMask: 'black' }),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'screenshot-screen-mask-unsupported' },
  });
  expect(screenshotIos).not.toHaveBeenCalled();
  expect(captureScreenshotViaRunner).not.toHaveBeenCalled();
});

test('an explicit runner capture never succeeds through the macOS helper', async () => {
  const macOs: DeviceInfo = { ...device, appleOs: 'macos', kind: 'device', target: 'desktop' };
  const refused = async (surface: 'desktop' | undefined, env: NodeJS.ProcessEnv) => {
    const interactor = createAppleInteractor(macOs, {}, { env, cwd: process.cwd() });
    await expect(
      interactor.screenshot('/tmp/refused.png', { captureBackend: 'runner', surface }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      details: { reason: 'screenshot-capture-backend-unsupported' },
    });
  };

  await refused('desktop', {});
  await refused(undefined, { AGENT_DEVICE_MACOS_APP_BACKEND: 'native' });

  expect(runMacOsScreenshotAction).not.toHaveBeenCalled();
  expect(captureScreenshotViaRunner).not.toHaveBeenCalled();
});
