import { expect, test, vi } from 'vitest';
import { alertRuntimeOperationFacts, bindAlertLeg } from './alert-runtime.ts';
import { localInteractorSource, providerInteractorSource } from './interactor-operation-binding.ts';
import type { AlertInteractorOptions, Interactor } from './interactor-types.ts';

const device = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'sim-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  booted: true,
} as const;

// The composition the interactor catalog performs, spelled out so each assertion below
// still exercises one facet executor reached through one interactor source.
const bindLocalAlertReadInteractor = (params: {
  device: typeof device;
  signal: AbortSignal;
  resolveInteractor: any;
}) => bindAlertLeg('readAlert', params.signal, localInteractorSource(params));
const bindLocalAlertWaitInteractor = (params: {
  device: typeof device;
  signal: AbortSignal;
  resolveInteractor: any;
}) => bindAlertLeg('awaitAlert', params.signal, localInteractorSource(params));
const bindLocalAlertAcceptInteractor = (params: {
  device: typeof device;
  signal: AbortSignal;
  resolveInteractor: any;
}) => bindAlertLeg('acceptAlert', params.signal, localInteractorSource(params));
const bindLocalAlertDismissInteractor = (params: {
  device: typeof device;
  signal: AbortSignal;
  resolveInteractor: any;
}) => bindAlertLeg('dismissAlert', params.signal, localInteractorSource(params));
const bindProviderAlertAcceptInteractor = (params: {
  device: typeof device;
  signal: AbortSignal;
  resolveInteractor: any;
}) =>
  bindAlertLeg(
    'acceptAlert',
    params.signal,
    providerInteractorSource({ ...params, operation: 'alert accept' }),
  );

test('builds the exact alert operation fact catalog', () => {
  const read = { available: true } as const;
  const wait = { available: false, reason: 'owner-capability-missing' } as const;
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
  const params = { device, signal, resolveInteractor };
  const input = {
    timeoutMs: 37,
    appBundleId: 'com.example.app',
    surface: 'app' as const,
    execution: { logPath: '/tmp/daemon.log', requestId: 'alert-1' },
  };

  await bindLocalAlertReadInteractor(params).readAlert(input);
  await bindLocalAlertWaitInteractor(params).awaitAlert(input);
  await bindLocalAlertAcceptInteractor(params).acceptAlert(input);
  await bindLocalAlertDismissInteractor(params).dismissAlert(input);

  const expectedOptions = { timeoutMs: 37, appBundleId: 'com.example.app', surface: 'app' };
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
  const operations = bindLocalAlertReadInteractor({
    device,
    signal: new AbortController().signal,
    resolveInteractor: async () => ({ readAlert }) as unknown as Interactor,
  });

  await operations.readAlert({ surface: 'frontmost-app' });

  expect(readAlert).toHaveBeenCalledWith({ surface: 'frontmost-app' });
  expect(Object.keys(readAlert.mock.calls[0]?.[0] ?? {})).toEqual(['surface']);
});

test('a provider binding fails closed when its exact owner exposes no interactor', async () => {
  const operations = bindProviderAlertAcceptInteractor({
    device,
    signal: new AbortController().signal,
    resolveInteractor: () => undefined,
  });

  await expect(operations.acceptAlert({})).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'provider-runtime-interactor-missing', deviceId: device.id },
  });
});

test('an already-cancelled request never resolves an interactor', async () => {
  const controller = new AbortController();
  controller.abort();
  const readAlert = vi.fn(async () => ({}));
  const resolveInteractor = vi.fn(async () => ({ readAlert }) as unknown as Interactor);

  const operations = bindLocalAlertReadInteractor({
    device,
    signal: controller.signal,
    resolveInteractor,
  });

  await expect(operations.readAlert({})).rejects.toThrow();
  expect(resolveInteractor).not.toHaveBeenCalled();
  expect(readAlert).not.toHaveBeenCalled();
});
