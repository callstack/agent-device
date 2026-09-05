import { expect, test, vi } from 'vitest';
import { appSwitcherRuntimeOperationFacts, bindAppSwitcher } from './app-switcher-runtime.ts';
import type { Interactor } from './interactor-types.ts';
import { localInteractorSource } from './interactor-operation-binding.ts';
import { conformInteractorOperations } from './interactor-operation-conformance.fixtures.ts';

const device = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} as const;

test('builds the exact app-switcher operation fact catalog', () => {
  const appSwitcher = { available: true } as const;
  expect(appSwitcherRuntimeOperationFacts({ appSwitcher })).toEqual({ appSwitcher });
});

test('a local binding drives the interactor with the request runner context', async () => {
  const appSwitcher = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ appSwitcher }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindAppSwitcher(signal, localInteractorSource({ device, resolveInteractor }));
  await operations.appSwitcher({
    options: { appBundleId: 'com.example.app' },
    execution: { logPath: '/tmp/daemon.log', requestId: 'switcher-1' },
  });

  expect(resolveInteractor).toHaveBeenCalledWith(device, {
    logPath: '/tmp/daemon.log',
    requestId: 'switcher-1',
    appBundleId: 'com.example.app',
    signal,
  });
  expect(appSwitcher).toHaveBeenCalledOnce();
});

conformInteractorOperations({
  device,
  rows: [
    {
      operation: 'appSwitcher',
      label: 'app-switcher',
      bind: bindAppSwitcher,
      method: 'appSwitcher',
      input: {},
    },
  ],
});
