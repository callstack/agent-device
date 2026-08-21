import { expect, test, vi } from 'vitest';
import type { Interactor } from './interactor-types.ts';
import {
  bindLocalTypeTextInteractor,
  bindProviderTypeTextInteractor,
  typeTextRuntimeOperationFacts,
} from './type-text-runtime.ts';

const device = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} as const;

test('builds the exact type operation fact catalog', () => {
  const type = { available: true } as const;
  expect(typeTextRuntimeOperationFacts({ type })).toEqual({ typeText: type });
});

test('a local binding drives the interactor with the text, delay, and resolver context', async () => {
  const type = vi.fn(async () => ({ textEntryRoute: 'synthesized-first-responder' }) as const);
  const resolveInteractor = vi.fn(async () => ({ type }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindLocalTypeTextInteractor({ device, signal, resolveInteractor });
  const result = await operations.typeText({
    text: 'hello world',
    delayMs: 25,
    options: { appBundleId: 'com.example.app' },
    execution: { logPath: '/tmp/daemon.log', requestId: 'type-1' },
  });

  expect(resolveInteractor).toHaveBeenCalledWith(device, {
    logPath: '/tmp/daemon.log',
    requestId: 'type-1',
    appBundleId: 'com.example.app',
    signal,
  });
  // Positional (text, delayMs): the `Interactor` seam takes two arguments, and a swapped or
  // dropped delay is the drift a structural assertion would not catch.
  expect(type).toHaveBeenCalledWith('hello world', 25);
  // The owner's closed result passes through untouched — the route evidence is the payload.
  expect(result).toEqual({ textEntryRoute: 'synthesized-first-responder' });
});

test('a provider binding drives its own resolved interactor and passes a blind result through', async () => {
  const type = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(() => ({ type }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindProviderTypeTextInteractor({ device, signal, resolveInteractor });
  const result = await operations.typeText({ text: 'abc', delayMs: 0 });

  expect(resolveInteractor).toHaveBeenCalledWith({
    appBundleId: undefined,
    signal,
  });
  expect(type).toHaveBeenCalledWith('abc', 0);
  expect(result).toBeUndefined();
});

test('a provider binding fails closed when its exact owner exposes no interactor', async () => {
  const operations = bindProviderTypeTextInteractor({
    device,
    signal: new AbortController().signal,
    resolveInteractor: () => undefined,
  });

  await expect(operations.typeText({ text: 'abc', delayMs: 0 })).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'provider-runtime-interactor-missing', deviceId: device.id },
  });
});

test('an already-cancelled request never resolves an interactor', async () => {
  const controller = new AbortController();
  controller.abort();
  const type = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ type }) as unknown as Interactor);

  const operations = bindLocalTypeTextInteractor({
    device,
    signal: controller.signal,
    resolveInteractor,
  });

  await expect(operations.typeText({ text: 'abc', delayMs: 0 })).rejects.toThrow();
  expect(resolveInteractor).not.toHaveBeenCalled();
  expect(type).not.toHaveBeenCalled();
});
