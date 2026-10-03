import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { SCREENSHOT_FULLSCREEN_REASONS } from '@agent-device/contracts/capture';
import type { PressPointOptions } from '@agent-device/contracts/interactor-types';
import {
  SESSION_SURFACES,
  type MacOsSurfaceBackend,
  type SessionSurface,
} from '@agent-device/contracts/session';

vi.mock('../os/macos/helper.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../os/macos/helper.ts')>();
  return {
    ...actual,
    runMacOsScreenshotAction: vi.fn(async (outPath: string) => ({ path: outPath })),
    runMacOsSnapshotAction: vi.fn(async (surface: SessionSurface) => ({
      surface,
      nodes: [],
      truncated: false,
      backend: 'macos-helper' as const,
    })),
    runMacOsReadTextAction: vi.fn(async () => ({ text: 'helper' })),
    runMacOsPressAction: vi.fn(async (x: number, y: number) => ({ x, y })),
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

vi.mock('../core/runner-client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/runner-client.ts')>();
  return {
    ...actual,
    runAppleRunnerCommand: vi.fn(async () => ({})),
  };
});

import { createAppleInteractor } from '../interactor.ts';
import {
  runMacOsPressAction,
  runMacOsReadTextAction,
  runMacOsScreenshotAction,
  runMacOsSnapshotAction,
} from '../os/macos/helper.ts';
import { captureScreenshotViaRunner, screenshotIos } from '../core/screenshot.ts';
import { runAppleRunnerCommand } from '../core/runner-client.ts';

const macOsDevice: DeviceInfo = {
  platform: 'apple',
  appleOs: 'macos',
  id: 'host-mac',
  name: 'Host Mac',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

const MACOS_SURFACE_BACKENDS: Record<SessionSurface, MacOsSurfaceBackend> = {
  app: 'xctest',
  'frontmost-app': 'macos-helper',
  desktop: 'macos-helper',
  menubar: 'macos-helper',
};

const SURFACE_ROWS = [
  ...SESSION_SURFACES.map((surface) => [surface, MACOS_SURFACE_BACKENDS[surface]] as const),
  [undefined, 'xctest'] as const,
];

const HELPER_ROWS = SESSION_SURFACES.filter(
  (surface) => MACOS_SURFACE_BACKENDS[surface] === 'macos-helper',
);

const PRIMARY_PRESS: Omit<PressPointOptions, 'surface'> = {
  button: 'primary',
  count: 1,
  intervalMs: 0,
  holdMs: 0,
  jitterPx: 0,
  doubleTap: false,
};

const helperEntryPoints = [
  runMacOsScreenshotAction,
  runMacOsSnapshotAction,
  runMacOsReadTextAction,
  runMacOsPressAction,
];
const runnerEntryPoints = [runAppleRunnerCommand, screenshotIos, captureScreenshotViaRunner];

function clearEntryPoints(): void {
  for (const entry of [...helperEntryPoints, ...runnerEntryPoints]) vi.mocked(entry).mockClear();
}

beforeEach(clearEntryPoints);

function reachedBackend(): MacOsSurfaceBackend {
  const helper = helperEntryPoints.some((entry) => vi.mocked(entry).mock.calls.length > 0);
  const runner = runnerEntryPoints.some((entry) => vi.mocked(entry).mock.calls.length > 0);
  expect(helper !== runner).toBe(true);
  return helper ? 'macos-helper' : 'xctest';
}

test.each(SURFACE_ROWS)(
  'every macOS operation on the %s surface reaches the %s backend',
  async (surface, backend) => {
    const interactor = createAppleInteractor(macOsDevice, {});
    const operations: Record<string, () => Promise<unknown>> = {
      screenshot: async () => await interactor.screenshot('/tmp/out.png', { surface }),
      snapshot: async () => await interactor.snapshot({ surface }),
      readTextAtPoint: async () => await interactor.readTextAtPoint?.({ x: 1, y: 2 }, { surface }),
      pressPoint: async () =>
        await interactor.pressPoint?.({ x: 1, y: 2 }, { ...PRIMARY_PRESS, surface }),
    };
    const reached: Record<string, MacOsSurfaceBackend> = {};
    for (const [name, run] of Object.entries(operations)) {
      clearEntryPoints();
      await run();
      reached[name] = reachedBackend();
    }
    expect(reached).toEqual({
      screenshot: backend,
      snapshot: backend,
      readTextAtPoint: backend,
      pressPoint: backend,
    });
  },
);

test.each(HELPER_ROWS)(
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

test.each(HELPER_ROWS)(
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
