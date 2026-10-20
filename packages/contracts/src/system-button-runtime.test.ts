import { expect, test, vi } from 'vitest';
import type { Interactor } from './interactor-types.ts';
import { localInteractorSource } from './interactor-operation-binding.ts';
import {
  SYSTEM_BUTTONS,
  bindSystemButton,
  systemButtonRuntimeOperationFacts,
} from './system-button-runtime.ts';

const device = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} as const;
const available = { available: true } as const;
const unsupported = { available: false, reason: 'unsupported-platform-leaf' } as const;

test('an omitted button reports the family denial, a named one its own cell', () => {
  expect(systemButtonRuntimeOperationFacts({ unsupported, home: available })).toEqual({
    home: available,
    appSwitcher: unsupported,
    actionButton: unsupported,
  });
  expect(systemButtonRuntimeOperationFacts({ unsupported })).toEqual({
    home: unsupported,
    appSwitcher: unsupported,
    actionButton: unsupported,
  });
});

test.each(SYSTEM_BUTTONS)(
  'a local %s binding presses the interactor once with no arguments',
  async (button) => {
    const press = vi.fn(async () => undefined);
    const resolveInteractor = vi.fn(async () => ({ [button]: press }) as unknown as Interactor);
    const signal = new AbortController().signal;

    const operations = bindSystemButton(
      button,
      signal,
      localInteractorSource({ device, resolveInteractor }),
    );
    await operations[button]({
      options: { appBundleId: 'com.example.app' },
      execution: { logPath: '/tmp/daemon.log', requestId: `${button}-1` },
    });

    expect(resolveInteractor).toHaveBeenCalledWith(device, {
      logPath: '/tmp/daemon.log',
      requestId: `${button}-1`,
      appBundleId: 'com.example.app',
      signal,
    });
    expect(press).toHaveBeenCalledExactlyOnceWith();
  },
);

test('an admitted button whose interactor lacks the member fails closed instead of no-op success', async () => {
  const resolveInteractor = vi.fn(async () => ({}) as unknown as Interactor);
  const operations = bindSystemButton(
    'actionButton',
    new AbortController().signal,
    localInteractorSource({ device, resolveInteractor }),
  );

  await expect(operations.actionButton({})).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'action-button was admitted but its bound interactor has no implementation.',
    details: { reason: 'interactor-method-missing' },
  });
});
