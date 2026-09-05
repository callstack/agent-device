import { expect, test, vi } from 'vitest';
import { bindHome, homeRuntimeOperationFacts } from './home-runtime.ts';
import type { Interactor } from './interactor-types.ts';
import { localInteractorSource } from './interactor-operation-binding.ts';

const device = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} as const;

test('builds the exact home operation fact catalog', () => {
  const home = { available: true } as const;
  expect(homeRuntimeOperationFacts({ home })).toEqual({ home });
});

test('a local binding drives the interactor with no arguments', async () => {
  const home = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ home }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindHome(signal, localInteractorSource({ device, resolveInteractor }));
  await operations.home({
    options: { appBundleId: 'com.example.app' },
    execution: { logPath: '/tmp/daemon.log', requestId: 'home-1' },
  });

  expect(resolveInteractor).toHaveBeenCalledWith(device, {
    logPath: '/tmp/daemon.log',
    requestId: 'home-1',
    appBundleId: 'com.example.app',
    signal,
  });
  expect(home).toHaveBeenCalledWith();
});
