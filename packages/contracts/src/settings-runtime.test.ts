import { expect, test, vi } from 'vitest';
import { runtimeSubjectFact } from './platform-runtime.ts';
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

const available = { available: true } as const;
const unsupported = {
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'not here',
} as const;
const handheldOnly = { available: false, reason: 'unsupported-device-kind' } as const;

test('a setting the owner does not list answers with its unsupported refusal', () => {
  const facts = settingsRuntimeOperationFacts({
    target: available,
    unsupported,
    write: { wifi: available, 'text-size': handheldOnly },
  });
  expect(runtimeSubjectFact(facts.setSetting, 'wifi')).toEqual(available);
  expect(runtimeSubjectFact(facts.setSetting, 'text-size')).toEqual(handheldOnly);
  expect(runtimeSubjectFact(facts.setSetting, 'airplane')).toEqual(unsupported);
  expect(facts.readSetting).toEqual(unsupported);
});

test('an unavailable target refuses every setting with its own fact', () => {
  const target = { available: false, reason: 'unsupported-device-kind', hint: 'kind' } as const;
  const facts = settingsRuntimeOperationFacts({ target, unsupported, write: { wifi: available } });
  expect(facts).toEqual({ setSetting: target, readSetting: target });
});

test('an operation none of whose settings is available answers with the first refusal', () => {
  const facts = settingsRuntimeOperationFacts({
    target: available,
    unsupported,
    write: { appearance: available },
    read: { 'text-size': handheldOnly },
  });
  expect(facts.readSetting).toEqual(handheldOnly);
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
