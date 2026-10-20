import { expect, test, vi } from 'vitest';
import type { Interactor } from './interactor-types.ts';
import { localInteractorSource } from './interactor-operation-binding.ts';
import { bindHardwareKey, hardwareKeyRuntimeOperationFacts } from './tv-remote-runtime.ts';

const device = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} as const;
const available = { available: true } as const;
const unsupported = { available: false, reason: 'unsupported-platform-leaf' } as const;

test('the hardware-key facts carry one cell', () => {
  expect(hardwareKeyRuntimeOperationFacts({ hardwareKey: available })).toEqual({
    hardwareKey: available,
  });
  expect(hardwareKeyRuntimeOperationFacts({ hardwareKey: unsupported })).toEqual({
    hardwareKey: unsupported,
  });
});

test('a local hardware-key binding presses the interactor once with the parsed key', async () => {
  const hardwareKey = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ hardwareKey }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindHardwareKey(signal, localInteractorSource({ device, resolveInteractor }));
  await operations.hardwareKey({
    key: 'media-play-pause',
    options: { appBundleId: 'com.example.app' },
    execution: { logPath: '/tmp/daemon.log', requestId: 'hardware-key-1' },
  });

  expect(resolveInteractor).toHaveBeenCalledWith(device, {
    logPath: '/tmp/daemon.log',
    requestId: 'hardware-key-1',
    appBundleId: 'com.example.app',
    signal,
  });
  expect(hardwareKey).toHaveBeenCalledExactlyOnceWith('media-play-pause');
});

test('an admitted hardware key whose interactor lacks the member fails closed', async () => {
  const resolveInteractor = vi.fn(async () => ({}) as unknown as Interactor);
  const operations = bindHardwareKey(
    new AbortController().signal,
    localInteractorSource({ device, resolveInteractor }),
  );

  await expect(operations.hardwareKey({ key: 'volume-up' })).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'hardware-key was admitted but its bound interactor has no implementation.',
    details: { reason: 'interactor-method-missing' },
  });
});
