import { expect, test, vi } from 'vitest';
import {
  bindLocalKeyboardDismissInteractor,
  bindLocalKeyboardEnterInteractor,
  bindLocalKeyboardStatusInteractor,
  bindProviderKeyboardDismissInteractor,
  bindProviderKeyboardEnterInteractor,
  bindProviderKeyboardStatusInteractor,
  keyboardRuntimeOperationFacts,
} from './keyboard-runtime.ts';
import type { Interactor } from './interactor-types.ts';

const device = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} as const;

test('builds the exact keyboard operation fact catalog', () => {
  const status = { available: true } as const;
  const dismiss = { available: false, reason: 'unsupported-platform-leaf' } as const;
  const enter = { available: true } as const;
  expect(keyboardRuntimeOperationFacts({ status, dismiss, enter })).toEqual({
    keyboardStatus: status,
    keyboardDismiss: dismiss,
    keyboardEnter: enter,
  });
});

test('a local status binding drives the interactor and returns its report', async () => {
  const keyboardStatus = vi.fn(async () => ({ visible: true }));
  const resolveInteractor = vi.fn(async () => ({ keyboardStatus }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindLocalKeyboardStatusInteractor({ device, signal, resolveInteractor });
  const result = await operations.keyboardStatus({
    options: { appBundleId: 'com.example.app' },
    execution: { logPath: '/tmp/daemon.log', requestId: 'keyboard-1' },
  });

  expect(resolveInteractor).toHaveBeenCalledWith(device, {
    logPath: '/tmp/daemon.log',
    requestId: 'keyboard-1',
    appBundleId: 'com.example.app',
    signal,
  });
  expect(keyboardStatus).toHaveBeenCalledTimes(1);
  expect(result).toEqual({ visible: true });
});

test('a local dismiss binding drives the interactor', async () => {
  const keyboardDismiss = vi.fn(async () => ({ dismissed: true, visible: false }));
  const resolveInteractor = vi.fn(async () => ({ keyboardDismiss }) as unknown as Interactor);
  const operations = bindLocalKeyboardDismissInteractor({
    device,
    signal: new AbortController().signal,
    resolveInteractor,
  });

  const result = await operations.keyboardDismiss({});

  expect(keyboardDismiss).toHaveBeenCalledTimes(1);
  expect(result).toEqual({ dismissed: true, visible: false });
});

test('a local enter binding drives the interactor', async () => {
  const keyboardEnter = vi.fn(async () => ({}));
  const resolveInteractor = vi.fn(async () => ({ keyboardEnter }) as unknown as Interactor);
  const operations = bindLocalKeyboardEnterInteractor({
    device,
    signal: new AbortController().signal,
    resolveInteractor,
  });

  await operations.keyboardEnter({});

  expect(keyboardEnter).toHaveBeenCalledTimes(1);
});

test('a provider binding drives its own resolved interactor', async () => {
  const keyboardStatus = vi.fn(async () => ({ visible: false }));
  const resolveInteractor = vi.fn(() => ({ keyboardStatus }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindProviderKeyboardStatusInteractor({ device, signal, resolveInteractor });
  await operations.keyboardStatus({ execution: { requestId: 'keyboard-2' } });

  expect(resolveInteractor).toHaveBeenCalledWith({
    requestId: 'keyboard-2',
    appBundleId: undefined,
    signal,
  });
  expect(keyboardStatus).toHaveBeenCalledTimes(1);
});

test('a provider binding fails closed when its exact owner exposes no interactor at all', async () => {
  const dismissOperations = bindProviderKeyboardDismissInteractor({
    device,
    signal: new AbortController().signal,
    resolveInteractor: () => undefined,
  });
  const enterOperations = bindProviderKeyboardEnterInteractor({
    device,
    signal: new AbortController().signal,
    resolveInteractor: () => undefined,
  });

  await expect(dismissOperations.keyboardDismiss({})).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'provider-runtime-interactor-missing', deviceId: device.id },
  });
  await expect(enterOperations.keyboardEnter({})).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'provider-runtime-interactor-missing', deviceId: device.id },
  });
});

test('binding fails as a runtime-contract error when the resolved interactor has no method — `Interactor.keyboardStatus`/`keyboardDismiss`/`keyboardEnter` are optional, so an owner whose fact admitted the operation but whose interactor omits it is a contract bug, not a normal refusal', async () => {
  // The interactor is resolved (unlike the "no interactor at all" case above), but it does not
  // implement `keyboardEnter` — parity with `hover`, which platforms with no keyboard concept
  // simply omit.
  const resolveInteractor = vi.fn(async () => ({}) as unknown as Interactor);
  const operations = bindLocalKeyboardEnterInteractor({
    device,
    signal: new AbortController().signal,
    resolveInteractor,
  });

  await expect(operations.keyboardEnter({})).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'interactor-method-missing' },
  });
});

test('an already-cancelled request never resolves an interactor', async () => {
  const controller = new AbortController();
  controller.abort();
  const keyboardStatus = vi.fn(async () => ({ visible: true }));
  const resolveInteractor = vi.fn(async () => ({ keyboardStatus }) as unknown as Interactor);

  const operations = bindLocalKeyboardStatusInteractor({
    device,
    signal: controller.signal,
    resolveInteractor,
  });

  await expect(operations.keyboardStatus({})).rejects.toThrow();
  expect(resolveInteractor).not.toHaveBeenCalled();
  expect(keyboardStatus).not.toHaveBeenCalled();
});
