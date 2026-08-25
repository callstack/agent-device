import { expect, test, vi } from 'vitest';
import { appSwitcherRuntimeOperationFacts, bindAppSwitcher } from './app-switcher-runtime.ts';
import type { Interactor } from './interactor-types.ts';
import { localInteractorSource, providerInteractorSource } from './interactor-operation-binding.ts';

const device = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} as const;

const bindAppSwitcherLocal = (
  params: Parameters<typeof localInteractorSource>[0] & { signal: AbortSignal },
) => bindAppSwitcher(params.signal, localInteractorSource(params));
const bindAppSwitcherProvider = (
  params: Parameters<typeof providerInteractorSource>[0] extends infer P
    ? Omit<P, 'operation'> & { signal: AbortSignal }
    : never,
) =>
  bindAppSwitcher(
    params.signal,
    providerInteractorSource({ ...params, operation: 'app-switcher' }),
  );

test('builds the exact app-switcher operation fact catalog', () => {
  const appSwitcher = { available: true } as const;
  expect(appSwitcherRuntimeOperationFacts({ appSwitcher })).toEqual({ appSwitcher });
});

test('a local binding drives the interactor with the request runner context', async () => {
  const appSwitcher = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ appSwitcher }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindAppSwitcherLocal({ device, signal, resolveInteractor });
  await operations.appSwitcher({
    options: { appBundleId: 'com.example.app' },
    execution: { logPath: '/tmp/daemon.log', requestId: 'switcher-1' },
  });

  expect(resolveInteractor).toHaveBeenCalledWith(device, {
    logPath: '/tmp/daemon.log',
    requestId: 'switcher-1',
    appBundleId: 'com.example.app',
    signal,
  });
  expect(appSwitcher).toHaveBeenCalledOnce();
});

test('a provider binding fails closed when its exact owner exposes no interactor', async () => {
  const operations = bindAppSwitcherProvider({
    device,
    signal: new AbortController().signal,
    resolveInteractor: () => undefined,
  });

  await expect(operations.appSwitcher({})).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'provider-runtime-interactor-missing', deviceId: device.id },
  });
});

test('an already-cancelled request never resolves an interactor', async () => {
  const controller = new AbortController();
  controller.abort();
  const appSwitcher = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ appSwitcher }) as unknown as Interactor);

  const operations = bindAppSwitcherLocal({
    device,
    signal: controller.signal,
    resolveInteractor,
  });

  await expect(operations.appSwitcher({})).rejects.toThrow();
  expect(resolveInteractor).not.toHaveBeenCalled();
  expect(appSwitcher).not.toHaveBeenCalled();
});
