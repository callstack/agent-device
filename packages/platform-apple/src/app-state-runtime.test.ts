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

function bind(liveRunner: boolean, interactor?: Interactor) {
  const appState = vi.fn(async () => ({ applicationState: 'runningBackground' as const }));
  const resolved: Interactor = interactor ?? ({ appState } as unknown as Interactor);
  const resolveInteractor = vi.fn(async () => resolved);
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

/**
 * The facts promised `appState` and the interactor has none. Answering from the session record
 * instead would invent a state the runner never read, so this fails as the contract bug it is
 * (ADR 0019 §2) rather than degrading, and the typed reason is what keeps it outside every
 * closed reason set that licenses a fallback.
 */
test('an advertised appState with no interactor implementation fails as a contract bug', async () => {
  // An interactor with NO appState — the mismatch the facts promised away.
  const { operations } = bind(true, {} as unknown as Interactor);
  await expect(operations.appState({ appBundleId: 'com.example.app' })).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: expect.stringContaining('advertised appState'),
    details: { reason: 'runtime-contract-invalid' },
  });
});
