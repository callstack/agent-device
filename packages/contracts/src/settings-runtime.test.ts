import { expect, test, vi } from 'vitest';
import { bindSetSetting, settingsRuntimeOperationFacts } from './settings-runtime.ts';
import type { Interactor } from './interactor-types.ts';
import { localInteractorSource, providerInteractorSource } from './interactor-operation-binding.ts';

const device = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'sim-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  booted: true,
} as const;

const bindSetSettingLocal = (
  params: Parameters<typeof localInteractorSource>[0] & { signal: AbortSignal },
) => bindSetSetting(params.signal, localInteractorSource(params));
const bindSetSettingProvider = (
  params: Parameters<typeof providerInteractorSource>[0] extends infer P
    ? Omit<P, 'operation'> & { signal: AbortSignal }
    : never,
) => bindSetSetting(params.signal, providerInteractorSource({ ...params, operation: 'settings' }));

test('builds the exact settings operation fact catalog', () => {
  const setSetting = { available: true } as const;
  expect(settingsRuntimeOperationFacts({ setSetting })).toEqual({ setSetting });
});

// The daemon has already parsed the CLI form, resolved the target app, and typed the coordinates
// by the time a binding runs, so what reaches the owner is its own settings vocabulary.
test('a local binding forwards the neutral mutation to its owner', async () => {
  const setSetting = vi.fn(async () => ({ message: 'Location updated' }));
  const resolveInteractor = vi.fn(async () => ({ setSetting }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindSetSettingLocal({ device, signal, resolveInteractor });
  const result = await operations.setSetting({
    setting: 'location',
    state: 'set',
    appBundleId: 'com.example.app',
    options: { latitude: 37.33, longitude: -122.03 },
    execution: { logPath: '/tmp/daemon.log', requestId: 'settings-1' },
  });

  expect(resolveInteractor).toHaveBeenCalledWith(device, {
    logPath: '/tmp/daemon.log',
    requestId: 'settings-1',
    appBundleId: 'com.example.app',
    signal,
  });
  expect(setSetting).toHaveBeenCalledWith('location', 'set', 'com.example.app', {
    latitude: 37.33,
    longitude: -122.03,
  });
  expect(result).toEqual({ message: 'Location updated' });
});

test('a provider binding fails closed when its exact owner exposes no interactor', async () => {
  const operations = bindSetSettingProvider({
    device,
    signal: new AbortController().signal,
    resolveInteractor: () => undefined,
  });

  await expect(
    operations.setSetting({ setting: 'appearance', state: 'dark' }),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'provider-runtime-interactor-missing', deviceId: device.id },
  });
});

test('an already-cancelled request never resolves an interactor', async () => {
  const controller = new AbortController();
  controller.abort();
  const setSetting = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ setSetting }) as unknown as Interactor);

  const operations = bindSetSettingLocal({
    device,
    signal: controller.signal,
    resolveInteractor,
  });

  await expect(operations.setSetting({ setting: 'appearance', state: 'dark' })).rejects.toThrow();
  expect(resolveInteractor).not.toHaveBeenCalled();
  expect(setSetting).not.toHaveBeenCalled();
});
