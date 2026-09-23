import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { SCREENSHOT_FULLSCREEN_REASONS } from '@agent-device/contracts/capture';
import { SESSION_SURFACES } from '@agent-device/contracts/session';

vi.mock('../os/macos/helper.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../os/macos/helper.ts')>();
  return {
    ...actual,
    runMacOsScreenshotAction: vi.fn(async (outPath: string) => ({ path: outPath })),
  };
});

vi.mock('../core/screenshot.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/screenshot.ts')>();
  return {
    ...actual,
    captureScreenshotViaRunner: vi.fn(),
    screenshotIos: vi.fn(),
  };
});

import { createAppleInteractor } from '../interactor.ts';
import { runMacOsScreenshotAction } from '../os/macos/helper.ts';
import { screenshotIos } from '../core/screenshot.ts';

const macOsDevice: DeviceInfo = {
  platform: 'apple',
  appleOs: 'macos',
  id: 'host-mac',
  name: 'Host Mac',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

beforeEach(() => {
  vi.mocked(runMacOsScreenshotAction).mockClear();
  vi.mocked(screenshotIos).mockClear();
});

// The helper-routed domain, derived from the same condition `usesMacOsSurfaceScreenshot` applies
// (every session surface except `app`) rather than a hand-picked list — so adding a surface to
// `SESSION_SURFACES` extends this coverage automatically instead of silently falling outside it.
const helperRoutedSurfaces = SESSION_SURFACES.filter((surface) => surface !== 'app');

test.each(helperRoutedSurfaces)(
  'refuses an explicit --fullscreen on the macOS %s surface before any capture',
  async (surface) => {
    const interactor = createAppleInteractor(macOsDevice, {});

    await expect(
      interactor.screenshot('/tmp/out.png', { surface, fullscreen: true }),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGS',
      details: expect.objectContaining({
        reason: SCREENSHOT_FULLSCREEN_REASONS.macOsHelperSurfaceFixedFrame,
        surface,
      }),
    });

    expect(runMacOsScreenshotAction).not.toHaveBeenCalled();
  },
);

test.each(helperRoutedSurfaces)(
  'captures the %s surface through the helper when --fullscreen is not requested',
  async (surface) => {
    const interactor = createAppleInteractor(macOsDevice, {});

    await interactor.screenshot('/tmp/out.png', { surface });

    expect(runMacOsScreenshotAction).toHaveBeenCalledOnce();
    const [, options] = vi.mocked(runMacOsScreenshotAction).mock.calls[0]!;
    expect(options).toEqual({ surface });
    expect(Object.hasOwn(options ?? {}, 'fullscreen')).toBe(false);
  },
);

test('keeps a macOS app session on the runner path with --fullscreen unchanged', async () => {
  const interactor = createAppleInteractor(macOsDevice, {});

  await interactor.screenshot('/tmp/out.png', { surface: 'app', fullscreen: true });

  expect(runMacOsScreenshotAction).not.toHaveBeenCalled();
  expect(screenshotIos).toHaveBeenCalledOnce();
  expect(screenshotIos).toHaveBeenCalledWith(
    macOsDevice,
    '/tmp/out.png',
    expect.objectContaining({ fullscreen: true }),
  );
});
