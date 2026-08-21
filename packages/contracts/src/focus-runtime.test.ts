import { expect, test, vi } from 'vitest';
import {
  bindLocalFocusInteractor,
  bindProviderFocusInteractor,
  focusRuntimeOperationFacts,
} from './focus-runtime.ts';
import type { Interactor } from './interactor-types.ts';

const device = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} as const;

test('builds the exact focus operation fact catalog', () => {
  const focus = { available: true } as const;
  expect(focusRuntimeOperationFacts({ focus })).toEqual({ focusPoint: focus });
});

test('a local binding drives the interactor at the resolved point', async () => {
  const focus = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ focus }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindLocalFocusInteractor({ device, signal, resolveInteractor });
  await operations.focusPoint({
    point: { x: 176, y: 132 },
    options: { appBundleId: 'com.example.app' },
    execution: { logPath: '/tmp/daemon.log', requestId: 'focus-1' },
  });

  expect(resolveInteractor).toHaveBeenCalledWith(device, {
    logPath: '/tmp/daemon.log',
    requestId: 'focus-1',
    appBundleId: 'com.example.app',
    signal,
  });
  // Positional (x, y), not an object: the `Interactor` seam takes two numbers, and swapping them
  // is the one transposition a point-shaped assertion would not catch.
  expect(focus).toHaveBeenCalledWith(176, 132);
});

test('a provider binding drives its own resolved interactor at the point', async () => {
  const focus = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(() => ({ focus }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindProviderFocusInteractor({ device, signal, resolveInteractor });
  await operations.focusPoint({ point: { x: 12, y: 34 }, execution: { requestId: 'focus-2' } });

  expect(resolveInteractor).toHaveBeenCalledWith({
    requestId: 'focus-2',
    appBundleId: undefined,
    signal,
  });
  expect(focus).toHaveBeenCalledWith(12, 34);
});

test('a provider binding fails closed when its exact owner exposes no interactor', async () => {
  const operations = bindProviderFocusInteractor({
    device,
    signal: new AbortController().signal,
    resolveInteractor: () => undefined,
  });

  await expect(operations.focusPoint({ point: { x: 1, y: 2 } })).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'provider-runtime-interactor-missing', deviceId: device.id },
  });
});

test('an already-cancelled request never resolves an interactor', async () => {
  const controller = new AbortController();
  controller.abort();
  const focus = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ focus }) as unknown as Interactor);

  const operations = bindLocalFocusInteractor({
    device,
    signal: controller.signal,
    resolveInteractor,
  });

  await expect(operations.focusPoint({ point: { x: 1, y: 2 } })).rejects.toThrow();
  expect(resolveInteractor).not.toHaveBeenCalled();
  expect(focus).not.toHaveBeenCalled();
});
