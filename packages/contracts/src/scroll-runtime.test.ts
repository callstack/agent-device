import { expect, test, vi } from 'vitest';
import {
  bindLocalScrollInteractor,
  bindProviderScrollInteractor,
  scrollRuntimeOperationFacts,
} from './scroll-runtime.ts';
import type { Interactor } from './interactor-types.ts';

const device = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} as const;

const options = {
  amount: 0.55,
  pixels: undefined,
  durationMs: undefined,
  releaseBehavior: 'controlled',
} as const;

test('builds the exact scroll operation fact catalog', () => {
  const scroll = { available: true } as const;
  expect(scrollRuntimeOperationFacts({ scroll })).toEqual({ scrollDirection: scroll });
});

test('a local binding scrolls the owner in the requested direction', async () => {
  const scroll = vi.fn(async () => ({ pixels: 240 }));
  const resolveInteractor = vi.fn(async () => ({ scroll }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindLocalScrollInteractor({ device, signal, resolveInteractor });
  await expect(
    operations.scrollDirection({
      direction: 'down',
      options,
      target: { appBundleId: 'com.example.app' },
      execution: { logPath: '/tmp/daemon.log', requestId: 'scroll-1' },
    }),
  ).resolves.toEqual({ pixels: 240 });

  expect(resolveInteractor).toHaveBeenCalledWith(device, {
    logPath: '/tmp/daemon.log',
    requestId: 'scroll-1',
    appBundleId: 'com.example.app',
    signal,
  });
  // Positional (direction, options): the `Interactor` seam takes them in that order, and
  // transposing them is the one swap an object-shaped assertion would not catch.
  expect(scroll).toHaveBeenCalledWith('down', options);
});

test('a provider binding scrolls through its own resolved interactor', async () => {
  const scroll = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(() => ({ scroll }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindProviderScrollInteractor({ device, signal, resolveInteractor });
  await operations.scrollDirection({
    direction: 'up',
    options,
    execution: { requestId: 'scroll-2' },
  });

  expect(resolveInteractor).toHaveBeenCalledWith({
    requestId: 'scroll-2',
    appBundleId: undefined,
    signal,
  });
  expect(scroll).toHaveBeenCalledWith('up', options);
});

test('a provider binding fails closed when its exact owner exposes no interactor', async () => {
  const operations = bindProviderScrollInteractor({
    device,
    signal: new AbortController().signal,
    resolveInteractor: () => undefined,
  });

  await expect(operations.scrollDirection({ direction: 'down', options })).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'provider-runtime-interactor-missing', deviceId: device.id },
  });
});

test('an already-cancelled request never resolves an interactor', async () => {
  const controller = new AbortController();
  controller.abort();
  const scroll = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ scroll }) as unknown as Interactor);

  const operations = bindLocalScrollInteractor({
    device,
    signal: controller.signal,
    resolveInteractor,
  });

  await expect(operations.scrollDirection({ direction: 'down', options })).rejects.toThrow();
  expect(resolveInteractor).not.toHaveBeenCalled();
  expect(scroll).not.toHaveBeenCalled();
});
