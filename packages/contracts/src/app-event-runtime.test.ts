import { expect, test, vi } from 'vitest';
import { appEventRuntimeOperationFacts, bindAppEvent } from './app-event-runtime.ts';
import type { Interactor } from './interactor-types.ts';
import { localInteractorSource, providerInteractorSource } from './interactor-operation-binding.ts';

const device = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} as const;

const bindAppEventLocal = (
  params: Parameters<typeof localInteractorSource>[0] & { signal: AbortSignal },
) => bindAppEvent(params.signal, localInteractorSource(params));
const bindAppEventProvider = (
  params: Parameters<typeof providerInteractorSource>[0] extends infer P
    ? Omit<P, 'operation'> & { signal: AbortSignal }
    : never,
) =>
  bindAppEvent(
    params.signal,
    providerInteractorSource({ ...params, operation: 'trigger-app-event' }),
  );

test('builds the exact app-event operation fact catalog', () => {
  const triggerAppEvent = { available: true } as const;
  expect(appEventRuntimeOperationFacts({ triggerAppEvent })).toEqual({ triggerAppEvent });
});

// The URL is resolved daemon-side from the event name, payload, and per-platform template; what
// the owner receives is that URL and the app to open it against, nothing command-shaped.
test('a local binding opens the resolved event URL against the session app', async () => {
  const open = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ open }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindAppEventLocal({ device, signal, resolveInteractor });
  await operations.triggerAppEvent({
    eventUrl: 'myapp://agent-device/event?name=checkout',
    options: { appBundleId: 'com.example.app' },
    execution: { logPath: '/tmp/daemon.log', requestId: 'event-1' },
  });

  expect(resolveInteractor).toHaveBeenCalledWith(device, {
    logPath: '/tmp/daemon.log',
    requestId: 'event-1',
    appBundleId: 'com.example.app',
    signal,
  });
  expect(open).toHaveBeenCalledWith('myapp://agent-device/event?name=checkout', {
    appBundleId: 'com.example.app',
  });
});

test('a provider binding fails closed when its exact owner exposes no interactor', async () => {
  const operations = bindAppEventProvider({
    device,
    signal: new AbortController().signal,
    resolveInteractor: () => undefined,
  });

  await expect(operations.triggerAppEvent({ eventUrl: 'myapp://x' })).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'provider-runtime-interactor-missing', deviceId: device.id },
  });
});

test('an already-cancelled request never resolves an interactor', async () => {
  const controller = new AbortController();
  controller.abort();
  const open = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ open }) as unknown as Interactor);

  const operations = bindAppEventLocal({
    device,
    signal: controller.signal,
    resolveInteractor,
  });

  await expect(operations.triggerAppEvent({ eventUrl: 'myapp://x' })).rejects.toThrow();
  expect(resolveInteractor).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});
