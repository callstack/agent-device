import { expect, test, vi } from 'vitest';
import {
  bindOrientation,
  bindOrientationUnlock,
  orientationRuntimeOperationFacts,
} from './orientation-runtime.ts';
import type { Interactor } from './interactor-types.ts';
import { localInteractorSource } from './interactor-operation-binding.ts';

const device = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} as const;

test('builds the exact orientation operation fact catalog', () => {
  const orientation = { available: true } as const;
  const unlock = { available: false, reason: 'unsupported-platform-leaf' } as const;
  expect(orientationRuntimeOperationFacts({ orientation, unlock })).toEqual({
    setOrientation: orientation,
    unlockOrientation: unlock,
  });
});

test('a local binding drives the interactor with the requested rotation and returns its report', async () => {
  const setOrientation = vi.fn(async () => ({
    orientation: 'landscape-left' as const,
  }));
  const resolveInteractor = vi.fn(async () => ({ setOrientation }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindOrientation(signal, localInteractorSource({ device, resolveInteractor }));
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

test('a local unlock binding hands rotation back through the interactor', async () => {
  const unlockOrientation = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ unlockOrientation }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindOrientationUnlock(
    signal,
    localInteractorSource({ device, resolveInteractor }),
  );
  await operations.unlockOrientation({
    options: { appBundleId: 'com.example.app' },
    execution: { logPath: '/tmp/daemon.log', requestId: 'orientation-2' },
  });

  expect(resolveInteractor).toHaveBeenCalledWith(device, {
    logPath: '/tmp/daemon.log',
    requestId: 'orientation-2',
    appBundleId: 'com.example.app',
    signal,
  });
  expect(unlockOrientation).toHaveBeenCalledTimes(1);
});

test('an admitted unlock on an interactor without the member fails closed', async () => {
  const resolveInteractor = vi.fn(async () => ({}) as unknown as Interactor);
  const operations = bindOrientationUnlock(
    new AbortController().signal,
    localInteractorSource({ device, resolveInteractor }),
  );

  await expect(operations.unlockOrientation({})).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'interactor-method-missing' },
  });
});
