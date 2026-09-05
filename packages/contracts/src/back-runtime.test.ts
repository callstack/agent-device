import { expect, test, vi } from 'vitest';
import { bindBack, backRuntimeOperationFacts } from './back-runtime.ts';
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

test('builds the exact back operation fact catalog', () => {
  const back = { available: true } as const;
  expect(backRuntimeOperationFacts({ back })).toEqual({ back });
});

test('a local binding drives the interactor with the requested mode', async () => {
  const back = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ back }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindBack(signal, localInteractorSource({ device, resolveInteractor }));
  await operations.back({
    mode: 'system',
    options: { appBundleId: 'com.example.app' },
    execution: { logPath: '/tmp/daemon.log', requestId: 'back-1' },
  });

  expect(resolveInteractor).toHaveBeenCalledWith(device, {
    logPath: '/tmp/daemon.log',
    requestId: 'back-1',
    appBundleId: 'com.example.app',
    signal,
  });
  expect(back).toHaveBeenCalledWith('system');
});

conformInteractorOperations({
  device,
  rows: [
    {
      operation: 'back',
      label: 'back',
      bind: bindBack,
      method: 'back',
      input: {},
    },
  ],
});
