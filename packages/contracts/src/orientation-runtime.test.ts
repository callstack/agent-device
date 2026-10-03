import { expect, test, vi } from 'vitest';
import { bindOrientation, orientationRuntimeOperationFacts } from './orientation-runtime.ts';
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
  expect(orientationRuntimeOperationFacts({ orientation })).toEqual({
    setOrientation: orientation,
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
