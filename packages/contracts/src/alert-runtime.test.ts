import { expect, test, vi } from 'vitest';
import { alertRuntimeOperationFacts, bindAlertLeg } from './alert-runtime.ts';
import { localInteractorSource } from './interactor-operation-binding.ts';
import type { AlertInteractorOptions, Interactor } from './interactor-types.ts';

const device = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'sim-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  booted: true,
} as const;

test('builds the exact alert operation fact catalog', () => {
  const read = { available: true } as const;
  const wait = {
    available: false,
    reason: 'owner-capability-missing',
  } as const;
  const accept = { available: true } as const;
  const dismiss = { available: true } as const;

  expect(alertRuntimeOperationFacts({ read, wait, accept, dismiss })).toEqual({
    readAlert: read,
    awaitAlert: wait,
    acceptAlert: accept,
    dismissAlert: dismiss,
  });
});

// The whole input is the window this request allows and the session's own target; the owner
// decides how to spend the window and which backend answers.
test('each local leg forwards the window and the session target to its own owner method', async () => {
  const legs = {
    readAlert: vi.fn(async () => ({ title: 'Camera Access' })),
    awaitAlert: vi.fn(async () => ({ title: 'Camera Access' })),
    acceptAlert: vi.fn(async () => ({ accepted: true })),
    dismissAlert: vi.fn(async () => ({ dismissed: true })),
  };
  const resolveInteractor = vi.fn(async () => legs as unknown as Interactor);
  const signal = new AbortController().signal;
  const source = localInteractorSource({ device, resolveInteractor });
  const input = {
    timeoutMs: 37,
    appBundleId: 'com.example.app',
    surface: 'app' as const,
    execution: { logPath: '/tmp/daemon.log', requestId: 'alert-1' },
  };

  await bindAlertLeg('readAlert', signal, source).readAlert(input);
  await bindAlertLeg('awaitAlert', signal, source).awaitAlert(input);
  await bindAlertLeg('acceptAlert', signal, source).acceptAlert(input);
  await bindAlertLeg('dismissAlert', signal, source).dismissAlert(input);

  const expectedOptions = {
    timeoutMs: 37,
    appBundleId: 'com.example.app',
    surface: 'app',
  };
  expect(legs.readAlert).toHaveBeenCalledWith(expectedOptions);
  expect(legs.awaitAlert).toHaveBeenCalledWith(expectedOptions);
  expect(legs.acceptAlert).toHaveBeenCalledWith(expectedOptions);
  expect(legs.dismissAlert).toHaveBeenCalledWith(expectedOptions);
  expect(resolveInteractor).toHaveBeenLastCalledWith(device, {
    logPath: '/tmp/daemon.log',
    requestId: 'alert-1',
    appBundleId: 'com.example.app',
    signal,
  });
});

// A frontmost-app session carries no bundle at all, and the option object must not invent one.
test('an absent target field never reaches the owner as an explicit undefined', async () => {
  const readAlert = vi.fn(async (_options?: AlertInteractorOptions) => ({}));
  const resolveInteractor = async () => ({ readAlert }) as unknown as Interactor;
  const source = localInteractorSource({ device, resolveInteractor });
  const operations = bindAlertLeg('readAlert', new AbortController().signal, source);

  await operations.readAlert({ surface: 'frontmost-app' });

  expect(readAlert).toHaveBeenCalledWith({ surface: 'frontmost-app' });
  expect(Object.keys(readAlert.mock.calls[0]?.[0] ?? {})).toEqual(['surface']);
});
