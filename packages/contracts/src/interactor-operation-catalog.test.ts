import { expect, test, vi } from 'vitest';
import {
  bindAdmittedLocalInteractorOperations,
  bindAdmittedProviderInteractorOperations,
} from './interactor-operation-catalog.ts';
import type { Interactor } from './interactor-types.ts';

const device = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} as const;

const available = { available: true } as const;
const unavailable = { available: false, reason: 'unsupported-device-kind' } as const;

test('binds every requested operation the facts admitted, driving the resolved interactor', async () => {
  const back = vi.fn(async () => undefined);
  const home = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ back, home }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindAdmittedLocalInteractorOperations({
    device,
    signal,
    resolveInteractor,
    facts: { back: available, home: available },
    operations: ['back', 'home'],
  });

  expect(operations.back).toBeTypeOf('function');
  expect(operations.home).toBeTypeOf('function');
  await operations.back?.({});
  await operations.home?.({});
  expect(back).toHaveBeenCalledOnce();
  expect(home).toHaveBeenCalledOnce();
});

test('skips a requested operation the facts refused', () => {
  const operations = bindAdmittedLocalInteractorOperations({
    device,
    signal: new AbortController().signal,
    resolveInteractor: vi.fn(),
    facts: { back: available, home: unavailable },
    operations: ['back', 'home'],
  });

  expect(operations.back).toBeTypeOf('function');
  expect(operations.home).toBeUndefined();
});

test('never binds an admitted operation the caller did not request', () => {
  const operations = bindAdmittedLocalInteractorOperations({
    device,
    signal: new AbortController().signal,
    resolveInteractor: vi.fn(),
    facts: { back: available, home: available, tvRemote: available },
    operations: ['back'],
  });

  expect(operations.back).toBeTypeOf('function');
  expect(operations.home).toBeUndefined();
  expect(operations.tvRemote).toBeUndefined();
});

test('treats an operation missing from a partial facts map as unavailable', () => {
  const operations = bindAdmittedLocalInteractorOperations({
    device,
    signal: new AbortController().signal,
    resolveInteractor: vi.fn(),
    facts: { back: available },
    operations: ['back', 'tvRemote'],
  });

  expect(operations.back).toBeTypeOf('function');
  expect(operations.tvRemote).toBeUndefined();
});

test('a provider binding drives its own resolved interactor for every requested, admitted operation', async () => {
  const tvRemote = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(() => ({ tvRemote }) as unknown as Interactor);

  const operations = bindAdmittedProviderInteractorOperations({
    device,
    signal: new AbortController().signal,
    resolveInteractor,
    facts: { tvRemote: available },
    operations: ['back', 'home', 'tvRemote'],
  });

  expect(operations.back).toBeUndefined();
  expect(operations.home).toBeUndefined();
  expect(operations.tvRemote).toBeTypeOf('function');
  await operations.tvRemote?.({ button: 'select' });
  expect(tvRemote).toHaveBeenCalledWith('select', undefined);
});

test('a provider binding fails closed when its exact owner exposes no interactor', async () => {
  const operations = bindAdmittedProviderInteractorOperations({
    device,
    signal: new AbortController().signal,
    resolveInteractor: () => undefined,
    facts: { keyboardDismiss: available },
    operations: ['keyboardDismiss'],
  });

  await expect(operations.keyboardDismiss?.({})).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
  });
});
