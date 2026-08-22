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

test('binds every operation the facts admitted, driving the resolved interactor', async () => {
  const back = vi.fn(async () => undefined);
  const home = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ back, home }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindAdmittedLocalInteractorOperations({
    device,
    signal,
    resolveInteractor,
    facts: { back: available, home: available },
  });

  expect(operations.back).toBeTypeOf('function');
  expect(operations.home).toBeTypeOf('function');
  await operations.back?.({});
  await operations.home?.({});
  expect(back).toHaveBeenCalledOnce();
  expect(home).toHaveBeenCalledOnce();
});

test('skips an operation the facts refused', () => {
  const operations = bindAdmittedLocalInteractorOperations({
    device,
    signal: new AbortController().signal,
    resolveInteractor: vi.fn(),
    facts: { back: available, home: unavailable },
  });

  expect(operations.back).toBeTypeOf('function');
  expect(operations.home).toBeUndefined();
});

// #1955 review: the facts a caller passes are the ONLY source of truth for what binds — there is
// no separate, caller-maintained operation list that could drift from them. An operation the
// facts admit binds even if the caller only meant to name a couple of others.
test('binds every admitted operation the facts name, not just the ones a caller had in mind', () => {
  const operations = bindAdmittedLocalInteractorOperations({
    device,
    signal: new AbortController().signal,
    resolveInteractor: vi.fn(),
    facts: { back: available, home: available, tvRemote: available },
  });

  expect(operations.back).toBeTypeOf('function');
  expect(operations.home).toBeTypeOf('function');
  expect(operations.tvRemote).toBeTypeOf('function');
});

test('treats an operation missing from a partial facts map as unavailable', () => {
  const operations = bindAdmittedLocalInteractorOperations({
    device,
    signal: new AbortController().signal,
    resolveInteractor: vi.fn(),
    facts: { back: available },
  });

  expect(operations.back).toBeTypeOf('function');
  expect(operations.tvRemote).toBeUndefined();
});

test('a provider binding drives its own resolved interactor for every admitted operation', async () => {
  const tvRemote = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(() => ({ tvRemote }) as unknown as Interactor);

  const operations = bindAdmittedProviderInteractorOperations({
    device,
    signal: new AbortController().signal,
    resolveInteractor,
    facts: { tvRemote: available },
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
  });

  await expect(operations.keyboardDismiss?.({})).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
  });
});
