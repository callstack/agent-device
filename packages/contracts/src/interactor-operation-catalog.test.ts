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

// The facts a caller passes are the ONLY source of truth for what binds — there is no separate,
// caller-maintained operation list that could drift from them.
test('binds every one of the seven navigation operations when every fact admits it', async () => {
  const back = vi.fn(async () => undefined);
  const home = vi.fn(async () => undefined);
  const setOrientation = vi.fn(async () => undefined);
  const tvRemote = vi.fn(async () => undefined);
  const keyboardStatus = vi.fn(async () => ({ visible: false }));
  const keyboardDismiss = vi.fn(async () => ({ kind: 'acknowledged' }));
  const keyboardEnter = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(
    async () =>
      ({
        back,
        home,
        setOrientation,
        tvRemote,
        keyboardStatus,
        keyboardDismiss,
        keyboardEnter,
      }) as unknown as Interactor,
  );

  const operations = bindAdmittedLocalInteractorOperations({
    device,
    signal: new AbortController().signal,
    resolveInteractor,
    facts: {
      back: available,
      home: available,
      setOrientation: available,
      tvRemote: available,
      keyboardStatus: available,
      keyboardDismiss: available,
      keyboardEnter: available,
    },
  });

  expect(operations.back).toBeTypeOf('function');
  expect(operations.home).toBeTypeOf('function');
  expect(operations.setOrientation).toBeTypeOf('function');
  expect(operations.tvRemote).toBeTypeOf('function');
  expect(operations.keyboardStatus).toBeTypeOf('function');
  expect(operations.keyboardDismiss).toBeTypeOf('function');
  expect(operations.keyboardEnter).toBeTypeOf('function');

  await operations.back?.({});
  await operations.home?.({});
  await operations.setOrientation?.({ rotation: 'landscape-left' });
  await operations.tvRemote?.({ button: 'select' });
  await operations.keyboardStatus?.({});
  await operations.keyboardDismiss?.({});
  await operations.keyboardEnter?.({});

  expect(back).toHaveBeenCalledOnce();
  expect(home).toHaveBeenCalledOnce();
  expect(setOrientation).toHaveBeenCalledOnce();
  expect(tvRemote).toHaveBeenCalledOnce();
  expect(keyboardStatus).toHaveBeenCalledOnce();
  expect(keyboardDismiss).toHaveBeenCalledOnce();
  expect(keyboardEnter).toHaveBeenCalledOnce();
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
