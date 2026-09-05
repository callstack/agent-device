import { expect, test, vi } from 'vitest';
import {
  KEYBOARD_ACTION_LABELS,
  bindKeyboardAction,
  keyboardRuntimeOperationFacts,
} from './keyboard-runtime.ts';
import type { Interactor } from './interactor-types.ts';
import {
  localInteractorSource,
  type LocalInteractorOperationResolver,
} from './interactor-operation-binding.ts';
import { conformInteractorOperations } from './interactor-operation-conformance.fixtures.ts';

const device = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} as const;

const local = (resolveInteractor: LocalInteractorOperationResolver) =>
  localInteractorSource({ device, resolveInteractor });

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

  const operations = bindKeyboardAction('keyboardStatus', signal, local(resolveInteractor));
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
  const operations = bindKeyboardAction(
    'keyboardDismiss',
    new AbortController().signal,
    local(resolveInteractor),
  );

  const result = await operations.keyboardDismiss({});

  expect(keyboardDismiss).toHaveBeenCalledTimes(1);
  expect(result).toEqual({ dismissed: true, visible: false });
});

test('a local enter binding drives the interactor', async () => {
  const keyboardEnter = vi.fn(async () => ({}));
  const resolveInteractor = vi.fn(async () => ({ keyboardEnter }) as unknown as Interactor);
  const operations = bindKeyboardAction(
    'keyboardEnter',
    new AbortController().signal,
    local(resolveInteractor),
  );

  await operations.keyboardEnter({});

  expect(keyboardEnter).toHaveBeenCalledTimes(1);
});

test('binding fails as a runtime-contract error when the resolved interactor has no method — `Interactor.keyboardStatus`/`keyboardDismiss`/`keyboardEnter` are optional, so an owner whose fact admitted the operation but whose interactor omits it is a contract bug, not a normal refusal', async () => {
  // The interactor is resolved (unlike the "no interactor at all" case the conformance rows
  // cover), but it does not implement `keyboardEnter` — parity with `hover`, which platforms
  // with no keyboard concept simply omit.
  const resolveInteractor = vi.fn(async () => ({}) as unknown as Interactor);
  const operations = bindKeyboardAction(
    'keyboardEnter',
    new AbortController().signal,
    local(resolveInteractor),
  );

  await expect(operations.keyboardEnter({})).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'interactor-method-missing' },
  });
});

conformInteractorOperations({
  device,
  rows: [
    {
      operation: 'keyboardStatus',
      label: KEYBOARD_ACTION_LABELS.keyboardStatus,
      bind: (signal, resolve) => bindKeyboardAction('keyboardStatus', signal, resolve),
      method: 'keyboardStatus',
      input: {},
    },
    {
      operation: 'keyboardDismiss',
      label: KEYBOARD_ACTION_LABELS.keyboardDismiss,
      bind: (signal, resolve) => bindKeyboardAction('keyboardDismiss', signal, resolve),
      method: 'keyboardDismiss',
      input: {},
    },
    {
      operation: 'keyboardEnter',
      label: KEYBOARD_ACTION_LABELS.keyboardEnter,
      bind: (signal, resolve) => bindKeyboardAction('keyboardEnter', signal, resolve),
      method: 'keyboardEnter',
      input: {},
    },
  ],
});
