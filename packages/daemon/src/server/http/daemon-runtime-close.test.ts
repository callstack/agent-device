import { expect, test, vi } from 'vitest';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import {
  applicationLifecycleResourceFixture,
  daemonRuntimeDepsFixture,
  platformOwnerLifecycleFixture,
} from '../../__tests__/support/daemon-runtime-deps-fixture.ts';
import { lifecycleDeviceRuntimeGateway } from '../../__tests__/support/test-device-runtime-gateway.ts';
import { startDaemonRuntime } from './daemon-runtime.ts';

function hostFor(stateDir: string) {
  return createTestHostEnvironment({
    env: {
      ...process.env,
      AGENT_DEVICE_STATE_DIR: stateDir,
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
      AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
    },
  });
}

function providerRuntime(provider: string, shutdown: () => Promise<void>): ProviderDeviceRuntime {
  return { provider, shutdown, leaseLifecycle: {} } as unknown as ProviderDeviceRuntime;
}

const silent = { stderr: { write: () => {} }, stdout: { write: () => {} } };

test('close is idempotent and every caller receives the one report', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-close-');
  const stop = vi.fn(async () => {});
  const failing = vi.fn(async () => {
    throw new Error('provider refused to stop');
  });
  const signalListeners = process.listenerCount('SIGTERM');
  const runtime = await startDaemonRuntime({
    host: hostFor(stateDir),
    ...silent,
    composeDeps: daemonRuntimeDepsFixture({
      providerDeviceRuntimes: [providerRuntime('stops', stop), providerRuntime('fails', failing)],
      deviceRuntimeGateway: Object.freeze({
        ...lifecycleDeviceRuntimeGateway,
        applicationLifecycle: applicationLifecycleResourceFixture({
          detachForDaemonShutdown: async () => ['handed-off-device'],
          finalizeDaemonShutdown: async () => ['stopped-device'],
        }),
      }),
    }),
  });
  expect(process.listenerCount('SIGTERM')).toBe(signalListeners);

  const [first, second] = await Promise.all([runtime.close(), runtime.close()]);
  const third = await runtime.close();

  expect(second).toBe(first);
  expect(third).toBe(first);
  await expect(runtime.closed).resolves.toBe(first);
  expect(first.runners).toEqual({ stopped: ['stopped-device'], handedOff: ['handed-off-device'] });
  expect(first.sessions).toEqual({ closed: 0, failed: 0 });
  expect(first.providerReleases).toEqual({ completed: [], pending: [], unknown: [] });
  expect(first.plugins.disposed).toEqual(['stops']);
  expect(first.plugins.failed).toEqual([
    { provider: 'fails', error: expect.objectContaining({ message: 'provider refused to stop' }) },
  ]);
  expect(stop).toHaveBeenCalledOnce();
  expect(failing).toHaveBeenCalledOnce();
});

test('a startup that fails after acquiring resources rolls them back once', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-rollback-');
  const stop = vi.fn(async () => {});
  const clearLock = vi.fn(async () => {});
  const failure = new Error('startup step failed');
  const signalListeners = process.listenerCount('SIGTERM');

  await expect(
    startDaemonRuntime({
      host: hostFor(stateDir),
      ...silent,
      composeDeps: daemonRuntimeDepsFixture({
        providerDeviceRuntimes: [providerRuntime('stops', stop)],
        ownerLifecycle: platformOwnerLifecycleFixture({
          configureForDaemonLock: async () => {
            throw failure;
          },
          clearDaemonLockConfiguration: clearLock,
        }),
      }),
    }),
  ).rejects.toBe(failure);

  expect(stop).toHaveBeenCalledOnce();
  expect(clearLock).toHaveBeenCalledOnce();
  expect(process.listenerCount('SIGTERM')).toBe(signalListeners);
});
