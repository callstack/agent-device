import { expect, test, vi } from 'vitest';
import {
  bindLocalHomeInteractor,
  bindProviderHomeInteractor,
  homeRuntimeOperationFacts,
} from './home-runtime.ts';
import type { Interactor } from './interactor-types.ts';

const device = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} as const;

test('builds the exact home operation fact catalog', () => {
  const home = { available: true } as const;
  expect(homeRuntimeOperationFacts({ home })).toEqual({ home });
});

test('a local binding drives the interactor with no arguments', async () => {
  const home = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ home }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindLocalHomeInteractor({ device, signal, resolveInteractor });
  await operations.home({
    options: { appBundleId: 'com.example.app' },
    execution: { logPath: '/tmp/daemon.log', requestId: 'home-1' },
  });

  expect(resolveInteractor).toHaveBeenCalledWith(device, {
    logPath: '/tmp/daemon.log',
    requestId: 'home-1',
    appBundleId: 'com.example.app',
    signal,
  });
  expect(home).toHaveBeenCalledWith();
});

test('a provider binding drives its own resolved interactor', async () => {
  const home = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(() => ({ home }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindProviderHomeInteractor({ device, signal, resolveInteractor });
  await operations.home({ execution: { requestId: 'home-2' } });

  expect(resolveInteractor).toHaveBeenCalledWith({
    requestId: 'home-2',
    appBundleId: undefined,
    signal,
  });
  expect(home).toHaveBeenCalledTimes(1);
});

test('a provider binding fails closed when its exact owner exposes no interactor', async () => {
  const operations = bindProviderHomeInteractor({
    device,
    signal: new AbortController().signal,
    resolveInteractor: () => undefined,
  });

  await expect(operations.home({})).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'provider-runtime-interactor-missing', deviceId: device.id },
  });
});

test('an already-cancelled request never resolves an interactor', async () => {
  const controller = new AbortController();
  controller.abort();
  const home = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ home }) as unknown as Interactor);

  const operations = bindLocalHomeInteractor({
    device,
    signal: controller.signal,
    resolveInteractor,
  });

  await expect(operations.home({})).rejects.toThrow();
  expect(resolveInteractor).not.toHaveBeenCalled();
  expect(home).not.toHaveBeenCalled();
});
