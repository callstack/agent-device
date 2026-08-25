import { expect, test, vi } from 'vitest';
import { bindBack, backRuntimeOperationFacts } from './back-runtime.ts';
import type { Interactor } from './interactor-types.ts';
import { localInteractorSource, providerInteractorSource } from './interactor-operation-binding.ts';

const device = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} as const;

const bindBackLocal = (
  params: Parameters<typeof localInteractorSource>[0] & { signal: AbortSignal },
) => bindBack(params.signal, localInteractorSource(params));
const bindBackProvider = (
  params: Parameters<typeof providerInteractorSource>[0] extends infer P
    ? Omit<P, 'operation'> & { signal: AbortSignal }
    : never,
) => bindBack(params.signal, providerInteractorSource({ ...params, operation: 'back' }));

test('builds the exact back operation fact catalog', () => {
  const back = { available: true } as const;
  expect(backRuntimeOperationFacts({ back })).toEqual({ back });
});

test('a local binding drives the interactor with the requested mode', async () => {
  const back = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ back }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindBackLocal({ device, signal, resolveInteractor });
  await operations.back({
    mode: 'system',
    options: { appBundleId: 'com.example.app' },
    execution: { logPath: '/tmp/daemon.log', requestId: 'back-1' },
  });

  expect(resolveInteractor).toHaveBeenCalledWith(device, {
    logPath: '/tmp/daemon.log',
    requestId: 'back-1',
    appBundleId: 'com.example.app',
    signal,
  });
  expect(back).toHaveBeenCalledWith('system');
});

test('a provider binding drives its own resolved interactor', async () => {
  const back = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(() => ({ back }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindBackProvider({ device, signal, resolveInteractor });
  await operations.back({ execution: { requestId: 'back-2' } });

  expect(resolveInteractor).toHaveBeenCalledWith({
    requestId: 'back-2',
    appBundleId: undefined,
    signal,
  });
  expect(back).toHaveBeenCalledWith(undefined);
});

test('a provider binding fails closed when its exact owner exposes no interactor', async () => {
  const operations = bindBackProvider({
    device,
    signal: new AbortController().signal,
    resolveInteractor: () => undefined,
  });

  await expect(operations.back({})).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'provider-runtime-interactor-missing', deviceId: device.id },
  });
});

test('an already-cancelled request never resolves an interactor', async () => {
  const controller = new AbortController();
  controller.abort();
  const back = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ back }) as unknown as Interactor);

  const operations = bindBackLocal({
    device,
    signal: controller.signal,
    resolveInteractor,
  });

  await expect(operations.back({})).rejects.toThrow();
  expect(resolveInteractor).not.toHaveBeenCalled();
  expect(back).not.toHaveBeenCalled();
});
