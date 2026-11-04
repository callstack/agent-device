import { expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Interactor, ScreenshotOptions } from '@agent-device/contracts/interactor-types';
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
