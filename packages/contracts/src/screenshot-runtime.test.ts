import { expect, test, vi } from 'vitest';
import type { Interactor } from './interactor-types.ts';
import {
  bindLocalScreenshotInteractor,
  bindProviderScreenshotInteractor,
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

  const operations = bindLocalScreenshotInteractor({ device, signal, resolveInteractor });
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
  });

  await expect(operations.captureScreenshot({ outPath: '/tmp/out.png' })).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'provider-runtime-interactor-missing' },
  });
});
