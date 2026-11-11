import { expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Interactor, ScreenshotOptions } from '@agent-device/contracts/interactor-types';
import type { MacOsAppBackend, SessionSurface } from '@agent-device/contracts/session';
import { createApplePlatformRuntime } from './runtime.ts';
import { platformRuntimeHostFixture } from './runtime.fixtures.ts';

const simulator: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'sim-1',
  name: 'iPhone',
  kind: 'simulator',
  booted: true,
};

test.each([
  [simulator, {}, true],
  [{ ...simulator, appleOs: 'ipados' }, {}, true],
  [simulator, { captureBackend: 'runner' }, false],
  [{ ...simulator, kind: 'device' }, {}, false],
  [{ ...simulator, appleOs: 'macos', kind: 'device', target: 'desktop' }, {}, false],
  [{ ...simulator, appleOs: 'tvos', target: 'tv' }, {}, false],
  [{ ...simulator, appleOs: 'visionos' }, {}, false],
] satisfies [DeviceInfo, Partial<ScreenshotOptions>, boolean][])(
  'the bound Apple capture declares mask support for %j with %j: %s',
  async (device, options, supported) => {
    const screenshot = vi.fn(async () => ({ displayRotation: 'portrait' as const }));
    const resolve = vi.fn(async () => ({ screenshot }) as unknown as Interactor);
    const host = { ...platformRuntimeHostFixture(), localInteractors: { resolve } };
    const binding = await createApplePlatformRuntime(host).bind({
      device,
      intent: { kind: 'ordinary' },
      scope: {
        signal: new AbortController().signal,
        diagnostics: { emit: () => {} },
        progress: { report: () => {} },
      },
    });
    const capture = binding.operations.captureScreenshot;
    expect(capture).toBeDefined();
    const result = capture!({
      outPath: '/tmp/masked.png',
      options: { ...options, screenMask: 'black' },
    });
    if (supported) {
      await expect(result).resolves.toEqual({ displayRotation: 'portrait' });
      expect(screenshot).toHaveBeenCalledWith('/tmp/masked.png', {
        ...options,
        screenMask: 'black',
      });
    } else {
      await expect(result).rejects.toMatchObject({
        code: 'UNSUPPORTED_OPERATION',
        details: { reason: 'screenshot-screen-mask-unsupported' },
      });
      expect(resolve).not.toHaveBeenCalled();
    }
  },
);

const macOs: DeviceInfo = {
  platform: 'apple',
  appleOs: 'macos',
  id: 'host-macos-local',
  name: 'Mac',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

test.each([
  [simulator, undefined, undefined, true],
  [{ ...simulator, kind: 'device' }, undefined, undefined, true],
  [{ ...simulator, appleOs: 'tvos', target: 'tv' }, undefined, undefined, true],
  [macOs, undefined, undefined, true],
  [macOs, 'app', 'xctest', true],
  [macOs, undefined, 'native', false],
  [macOs, 'app', 'native', false],
  [macOs, 'desktop', undefined, false],
  [macOs, 'menubar', undefined, false],
  [macOs, 'frontmost-app', undefined, false],
] satisfies [DeviceInfo, SessionSurface | undefined, MacOsAppBackend | undefined, boolean][])(
  'the bound Apple capture declares runner support for %j on surface %s with app backend %s: %s',
  async (device, surface, appBackend, supported) => {
    const screenshot = vi.fn(async () => ({}));
    const resolve = vi.fn(async () => ({ screenshot }) as unknown as Interactor);
    const host = {
      ...platformRuntimeHostFixture(),
      hostEnvironment: {
        env: appBackend ? { AGENT_DEVICE_MACOS_APP_BACKEND: appBackend } : {},
        cwd: process.cwd(),
      },
      localInteractors: { resolve },
    };
    const binding = await createApplePlatformRuntime(host).bind({
      device,
      intent: { kind: 'ordinary' },
      scope: {
        signal: new AbortController().signal,
        diagnostics: { emit: () => {} },
        progress: { report: () => {} },
      },
    });
    const options = { captureBackend: 'runner', surface } as const;
    const result = binding.operations.captureScreenshot!({ outPath: '/tmp/r.png', options });
    if (supported) {
      await expect(result).resolves.toEqual({});
      expect(screenshot).toHaveBeenCalledWith('/tmp/r.png', options);
    } else {
      await expect(result).rejects.toMatchObject({
        code: 'UNSUPPORTED_OPERATION',
        details: { reason: 'screenshot-capture-backend-unsupported' },
      });
      expect(resolve).not.toHaveBeenCalled();
    }
  },
);

test('the shape the daemon passes for a Maestro preference selects the runner on an iOS simulator', async () => {
  const screenshot = vi.fn(async (_outPath: string, _options: ScreenshotOptions) => ({}));
  const host = {
    ...platformRuntimeHostFixture(),
    localInteractors: { resolve: async () => ({ screenshot }) as unknown as Interactor },
  };
  const binding = await createApplePlatformRuntime(host).bind({
    device: simulator,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });

  await binding.operations.captureScreenshot!({
    outPath: '/tmp/maestro.png',
    options: { captureBackend: undefined, preferredCaptureBackend: 'runner' },
  });

  expect(screenshot.mock.lastCall?.[1]).toEqual({ captureBackend: 'runner' });
});

test.each([
  [simulator, {}, true],
  [simulator, { captureBackend: 'runner' }, false],
  [{ ...simulator, kind: 'device' }, {}, false],
  [{ ...simulator, appleOs: 'tvos', target: 'tv' }, {}, false],
] satisfies [DeviceInfo, Partial<ScreenshotOptions>, boolean][])(
  'native density is admitted only for a reporting Apple capture: %j %j',
  async (device, options, supported) => {
    const screenshot = vi.fn(async () => ({ sourcePixelDensity: 3 }));
    const host = {
      ...platformRuntimeHostFixture(),
      localInteractors: { resolve: async () => ({ screenshot }) as unknown as Interactor },
    };
    const binding = await createApplePlatformRuntime(host).bind({
      device,
      intent: { kind: 'ordinary' },
      scope: {
        signal: new AbortController().signal,
        diagnostics: { emit: () => {} },
        progress: { report: () => {} },
      },
    });
    const result = binding.operations.captureScreenshot!({
      outPath: '/tmp/native.png',
      options: { ...options, nativeDensity: true },
    });
    if (supported) await expect(result).resolves.toEqual({ sourcePixelDensity: 3 });
    else
      await expect(result).rejects.toMatchObject({
        code: 'UNSUPPORTED_OPERATION',
        details: { reason: 'screenshot-native-density-unsupported' },
      });
  },
);
