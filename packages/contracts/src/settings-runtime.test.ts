import { expect, test, vi } from 'vitest';
import { bindSetSetting, settingsRuntimeOperationFacts } from './settings-runtime.ts';
import type { Interactor } from './interactor-types.ts';
import { localInteractorSource } from './interactor-operation-binding.ts';

const device = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'sim-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  booted: true,
} as const;

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

  const operations = bindSetSetting(signal, localInteractorSource({ device, resolveInteractor }));
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
