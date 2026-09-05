import { expect, test, vi } from 'vitest';
import { appEventRuntimeOperationFacts, bindAppEvent } from './app-event-runtime.ts';
import type { Interactor } from './interactor-types.ts';
import { localInteractorSource } from './interactor-operation-binding.ts';

const device = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} as const;

test('builds the exact app-event operation fact catalog', () => {
  const triggerAppEvent = { available: true } as const;
  expect(appEventRuntimeOperationFacts({ triggerAppEvent })).toEqual({
    triggerAppEvent,
  });
});

// The URL is resolved daemon-side from the event name, payload, and per-platform template; what
// the owner receives is that URL and the app to open it against, nothing command-shaped.
test('a local binding opens the resolved event URL against the session app', async () => {
  const open = vi.fn(async () => undefined);
  const resolveInteractor = vi.fn(async () => ({ open }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindAppEvent(signal, localInteractorSource({ device, resolveInteractor }));
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
