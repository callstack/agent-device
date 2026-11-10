import { expect, test, vi } from 'vitest';
import type { Interactor } from './interactor-types.ts';
import {
  bindLocalScreenshotInteractor,
  bindProviderScreenshotInteractor,
  defaultCaptureOnly,
  screenshotRuntimeOperationFacts,
} from './screenshot-runtime.ts';

const device = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} as const;

test('builds the exact screenshot operation fact catalog', () => {
  const capture = { available: true } as const;
  expect(screenshotRuntimeOperationFacts({ capture })).toEqual({ captureScreenshot: capture });
});

test('a local binding hands the interactor the destination, options, and the request signal', async () => {
  const screenshot = vi.fn(async () => {});
  const resolveInteractor = vi.fn(async () => ({ screenshot }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindLocalScreenshotInteractor({
    device,
    signal,
    resolveInteractor,
    captureCapabilities: defaultCaptureOnly('test'),
  });
  await operations.captureScreenshot({
    outPath: '/tmp/out.png',
    options: { appBundleId: 'com.example.app', fullscreen: true },
    execution: { logPath: '/tmp/daemon.log' },
  });

  expect(resolveInteractor).toHaveBeenCalledWith(device, {
    logPath: '/tmp/daemon.log',
    appBundleId: 'com.example.app',
    signal,
  });
  expect(screenshot).toHaveBeenCalledWith('/tmp/out.png', {
    appBundleId: 'com.example.app',
    fullscreen: true,
  });
});

test('a provider binding fails closed when its exact owner exposes no interactor', async () => {
  const operations = bindProviderScreenshotInteractor({
    device,
    signal: new AbortController().signal,
    resolveInteractor: () => undefined,
    captureCapabilities: defaultCaptureOnly('test'),
  });

  await expect(operations.captureScreenshot({ outPath: '/tmp/out.png' })).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'provider-runtime-interactor-missing' },
  });
});

test.each([bindLocalScreenshotInteractor, bindProviderScreenshotInteractor])(
  'a capture without a declared mask capability refuses before resolving its interactor',
  async (bind) => {
    const resolveInteractor = vi.fn();
    const operations = bind({
      device: { ...device, platform: 'apple', appleOs: 'ios', kind: 'simulator' },
      signal: new AbortController().signal,
      resolveInteractor,
      captureCapabilities: defaultCaptureOnly('test'),
    });
    await expect(
      operations.captureScreenshot({
        outPath: '/tmp/masked.png',
        options: { screenMask: 'black' },
      }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      details: { reason: 'screenshot-screen-mask-unsupported' },
    });
    expect(resolveInteractor).not.toHaveBeenCalled();
  },
);

test('the selected capture capability admits a mask for one invocation without changing the next', async () => {
  const screenshot = vi.fn(async () => ({ displayRotation: 'portrait' as const }));
  const operations = bindLocalScreenshotInteractor({
    device,
    signal: new AbortController().signal,
    resolveInteractor: async () => ({ screenshot }) as unknown as Interactor,
    captureCapabilities: () => ({ screenMask: true }),
  });
  for (const screenMask of ['black', undefined] as const) {
    await expect(
      operations.captureScreenshot({ outPath: '/tmp/capture.png', options: { screenMask } }),
    ).resolves.toEqual({ displayRotation: 'portrait' });
    expect(screenshot.mock.lastCall).toEqual(['/tmp/capture.png', { screenMask }]);
  }
});

test.each([bindLocalScreenshotInteractor, bindProviderScreenshotInteractor])(
  'an owner declaring no capture backend refuses an explicit one with its own explanation',
  async (bind) => {
    const resolveInteractor = vi.fn();
    const operations = bind({
      device,
      signal: new AbortController().signal,
      resolveInteractor,
      captureCapabilities: defaultCaptureOnly('this owner has one capture path'),
    });
    await expect(
      operations.captureScreenshot({
        outPath: '/tmp/capture.png',
        options: { captureBackend: 'runner' },
      }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      message: expect.stringContaining('this owner has one capture path'),
      details: { reason: 'screenshot-capture-backend-unsupported' },
    });
    expect(resolveInteractor).not.toHaveBeenCalled();
  },
);

test.each([
  [['runner'] as const, { captureBackend: 'runner' }],
  [[] as const, {}],
])(
  'a preferred backend selects a declared one and otherwise keeps the default capture: %j',
  async (captureBackends, expected) => {
    const screenshot = vi.fn(async (_outPath: string, _options: unknown) => ({}));
    const operations = bindLocalScreenshotInteractor({
      device,
      signal: new AbortController().signal,
      resolveInteractor: async () => ({ screenshot }) as unknown as Interactor,
      captureCapabilities: () => ({ captureBackends }),
    });
    await operations.captureScreenshot({
      outPath: '/tmp/capture.png',
      options: { captureBackend: undefined, preferredCaptureBackend: 'runner' },
    });
    expect(screenshot).toHaveBeenLastCalledWith('/tmp/capture.png', expected);
  },
);

test.each([bindLocalScreenshotInteractor, bindProviderScreenshotInteractor])(
  'a capture owner without native density support refuses the request before capture',
  async (bind) => {
    const resolveInteractor = vi.fn();
    const operations = bind({
      device: { ...device, platform: 'apple', appleOs: 'ios', kind: 'simulator' },
      signal: new AbortController().signal,
      resolveInteractor,
      captureCapabilities: defaultCaptureOnly('provider capture'),
    });
    await expect(
      operations.captureScreenshot({ outPath: '/tmp/out.png', options: { nativeDensity: true } }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      details: { reason: 'screenshot-native-density-unsupported' },
    });
    expect(resolveInteractor).not.toHaveBeenCalled();
  },
);
