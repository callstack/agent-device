import { expect, test, vi } from 'vitest';
import { bindTvRemote, tvRemoteRuntimeOperationFacts } from './tv-remote-runtime.ts';
import type { Interactor } from './interactor-types.ts';
import { localInteractorSource, providerInteractorSource } from './interactor-operation-binding.ts';

const device = {
  platform: 'vega',
  id: 'vega-vvd',
  name: 'Vega VVD',
  kind: 'emulator',
  booted: true,
} as const;

const bindTvRemoteLocal = (
  params: Parameters<typeof localInteractorSource>[0] & { signal: AbortSignal },
) => bindTvRemote(params.signal, localInteractorSource(params));
const bindTvRemoteProvider = (
  params: Parameters<typeof providerInteractorSource>[0] extends infer P
    ? Omit<P, 'operation'> & { signal: AbortSignal }
    : never,
) => bindTvRemote(params.signal, providerInteractorSource({ ...params, operation: 'tv-remote' }));

test('builds the exact tv-remote operation fact catalog', () => {
  const tvRemote = { available: true } as const;
  expect(tvRemoteRuntimeOperationFacts({ tvRemote })).toEqual({ tvRemote });
});

test('a local binding drives the interactor with the button and duration', async () => {
  const tvRemote = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ tvRemote }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindTvRemoteLocal({ device, signal, resolveInteractor });
  await operations.tvRemote({
    button: 'down',
    durationMs: 250,
    options: { appBundleId: 'com.example.app' },
    execution: { logPath: '/tmp/daemon.log', requestId: 'tv-remote-1' },
  });

  expect(resolveInteractor).toHaveBeenCalledWith(device, {
    logPath: '/tmp/daemon.log',
    requestId: 'tv-remote-1',
    appBundleId: 'com.example.app',
    signal,
  });
  // Positional (button, durationMs), not an object: swapping the argument order or dropping
  // durationMs is the one transposition a point-shaped assertion would not catch.
  expect(tvRemote).toHaveBeenCalledWith('down', 250);
});

test('a provider binding drives its own resolved interactor', async () => {
  const tvRemote = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(() => ({ tvRemote }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindTvRemoteProvider({ device, signal, resolveInteractor });
  await operations.tvRemote({ button: 'select', execution: { requestId: 'tv-remote-2' } });

  expect(resolveInteractor).toHaveBeenCalledWith({
    requestId: 'tv-remote-2',
    appBundleId: undefined,
    signal,
  });
  expect(tvRemote).toHaveBeenCalledWith('select', undefined);
});

test('a provider binding fails closed when its exact owner exposes no interactor', async () => {
  const operations = bindTvRemoteProvider({
    device,
    signal: new AbortController().signal,
    resolveInteractor: () => undefined,
  });

  await expect(operations.tvRemote({ button: 'down' })).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'provider-runtime-interactor-missing', deviceId: device.id },
  });
});

test('an already-cancelled request never resolves an interactor', async () => {
  const controller = new AbortController();
  controller.abort();
  const tvRemote = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ tvRemote }) as unknown as Interactor);

  const operations = bindTvRemoteLocal({
    device,
    signal: controller.signal,
    resolveInteractor,
  });

  await expect(operations.tvRemote({ button: 'down' })).rejects.toThrow();
  expect(resolveInteractor).not.toHaveBeenCalled();
  expect(tvRemote).not.toHaveBeenCalled();
});
