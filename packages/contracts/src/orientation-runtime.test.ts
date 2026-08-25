import { expect, test, vi } from 'vitest';
import { bindOrientation, orientationRuntimeOperationFacts } from './orientation-runtime.ts';
import type { Interactor } from './interactor-types.ts';
import { localInteractorSource, providerInteractorSource } from './interactor-operation-binding.ts';

const device = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} as const;

const bindOrientationLocal = (
  params: Parameters<typeof localInteractorSource>[0] & { signal: AbortSignal },
) => bindOrientation(params.signal, localInteractorSource(params));
const bindOrientationProvider = (
  params: Parameters<typeof providerInteractorSource>[0] extends infer P
    ? Omit<P, 'operation'> & { signal: AbortSignal }
    : never,
) =>
  bindOrientation(params.signal, providerInteractorSource({ ...params, operation: 'orientation' }));

test('builds the exact orientation operation fact catalog', () => {
  const orientation = { available: true } as const;
  expect(orientationRuntimeOperationFacts({ orientation })).toEqual({
    setOrientation: orientation,
  });
});

test('a local binding drives the interactor with the requested rotation and returns its report', async () => {
  const setOrientation = vi.fn(async () => ({ orientation: 'landscape-left' as const }));
  const resolveInteractor = vi.fn(async () => ({ setOrientation }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindOrientationLocal({ device, signal, resolveInteractor });
  const result = await operations.setOrientation({
    rotation: 'landscape-left',
    options: { appBundleId: 'com.example.app' },
    execution: { logPath: '/tmp/daemon.log', requestId: 'orientation-1' },
  });

  expect(resolveInteractor).toHaveBeenCalledWith(device, {
    logPath: '/tmp/daemon.log',
    requestId: 'orientation-1',
    appBundleId: 'com.example.app',
    signal,
  });
  expect(setOrientation).toHaveBeenCalledWith('landscape-left');
  expect(result).toEqual({ orientation: 'landscape-left' });
});

test('a provider binding drives its own resolved interactor', async () => {
  const setOrientation = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(() => ({ setOrientation }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindOrientationProvider({ device, signal, resolveInteractor });
  await operations.setOrientation({
    rotation: 'portrait',
    execution: { requestId: 'orientation-2' },
  });

  expect(resolveInteractor).toHaveBeenCalledWith({
    requestId: 'orientation-2',
    appBundleId: undefined,
    signal,
  });
  expect(setOrientation).toHaveBeenCalledWith('portrait');
});

test('a provider binding fails closed when its exact owner exposes no interactor', async () => {
  const operations = bindOrientationProvider({
    device,
    signal: new AbortController().signal,
    resolveInteractor: () => undefined,
  });

  await expect(operations.setOrientation({ rotation: 'portrait' })).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'provider-runtime-interactor-missing', deviceId: device.id },
  });
});

test('an already-cancelled request never resolves an interactor', async () => {
  const controller = new AbortController();
  controller.abort();
  const setOrientation = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ setOrientation }) as unknown as Interactor);

  const operations = bindOrientationLocal({
    device,
    signal: controller.signal,
    resolveInteractor,
  });

  await expect(operations.setOrientation({ rotation: 'portrait' })).rejects.toThrow();
  expect(resolveInteractor).not.toHaveBeenCalled();
  expect(setOrientation).not.toHaveBeenCalled();
});
