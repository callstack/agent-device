import { expect, test, vi } from 'vitest';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { bindAppleAppStateRuntime } from './app-state-runtime.ts';

const device: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'sim-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

function bind(liveRunner: boolean) {
  const appState = vi.fn(async () => ({ applicationState: 'runningBackground' as const }));
  const resolveInteractor = vi.fn(async () => ({ appState }) as unknown as Interactor);
  const hasLiveRunnerSession = vi.fn(async () => liveRunner);
  const operations = bindAppleAppStateRuntime(
    { appleApplications: { hasLiveRunnerSession } as never },
    { device, signal: new AbortController().signal, resolveInteractor },
  );
  return { operations, appState, resolveInteractor, hasLiveRunnerSession };
}

test('a live runner session answers the session app state through the interactor', async () => {
  const { operations, appState, resolveInteractor } = bind(true);
  await expect(operations.appState({ appBundleId: 'com.example.app' })).resolves.toEqual({
    applicationState: 'runningBackground',
  });
  expect(appState).toHaveBeenCalledTimes(1);
  expect(resolveInteractor).toHaveBeenCalledWith(
    device,
    expect.objectContaining({ appBundleId: 'com.example.app' }),
  );
});

test('without a live runner session the read answers nothing and resolves no interactor', async () => {
  // Resolving the interactor is what would start a runner; a session-state read never does.
  const { operations, resolveInteractor, hasLiveRunnerSession } = bind(false);
  await expect(operations.appState({ appBundleId: 'com.example.app' })).resolves.toEqual({});
  expect(hasLiveRunnerSession).toHaveBeenCalledWith(device, {});
  expect(resolveInteractor).not.toHaveBeenCalled();
});
