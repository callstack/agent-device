import fs from 'node:fs';
import { expect, test, vi } from 'vitest';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { clearAndroidObservationFixture } from '../../__tests__/support/android-observation-fixture.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { daemonRuntimeDepsFixture } from '../../__tests__/support/daemon-runtime-deps-fixture.ts';
import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import { providerCredentialsFixture } from '../../__tests__/support/provider-credentials-fixture.ts';
import { startDaemonRuntime } from './daemon-runtime.ts';

const silent = { stderr: { write: () => {} }, stdout: { write: () => {} } };

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

test('a request that ignores cancellation is abandoned at the drain budget and keeps the registration', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-bounded-close-');
  const paths = resolveDaemonPaths(stateDir);
  const reached = vi.fn();
  const runtime = await startDaemonRuntime({
    host: hostFor(stateDir),
    ...silent,
    shutdownBudgets: { requestDrainMs: 50 },
    composeDeps: daemonRuntimeDepsFixture((input) => ({
      requestRouter: Object.freeze({
        deviceInventoryGateways: createTestDeviceInventoryGateways({
          local: async () => {
            reached();
            return await new Promise(() => {});
          },
        }),
        platformServices: daemonPlatformServicesFixture(),
        androidObservation: clearAndroidObservationFixture,
        providerCredentials: providerCredentialsFixture(input.host.env, input.baseDir),
        createCommandSurface: fakeCreateCommandSurface,
      }),
    })),
  });
  const hung = fetch(`http://127.0.0.1:${runtime.httpPort}/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${runtime.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'hung-1',
      method: 'agent_device.command',
      params: { command: 'devices', meta: { requestId: 'hung-1' } },
    }),
  }).catch(() => undefined);
  await vi.waitFor(() => expect(reached).toHaveBeenCalled());

  const report = await runtime.close();

  expect(report.requests).toEqual({ drained: 0, abandoned: 1 });
  expect(fs.existsSync(paths.infoPath)).toBe(true);
  await hung;
});

test('a plugin that never finishes shutting down is reported pending at the budget', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-bounded-plugin-');
  const stuck = {
    provider: 'stuck',
    shutdown: () => new Promise<void>(() => {}),
    leaseLifecycle: {},
  };
  const done = { provider: 'done', shutdown: async () => {}, leaseLifecycle: {} };
  const runtime = await startDaemonRuntime({
    host: hostFor(stateDir),
    ...silent,
    shutdownBudgets: { pluginMs: 50 },
    composeDeps: daemonRuntimeDepsFixture({
      providerDeviceRuntimes: [stuck, done] as unknown as ProviderDeviceRuntime[],
    }),
  });

  const report = await runtime.close();

  expect(report.plugins).toEqual({ disposed: ['done'], failed: [], pending: ['stuck'] });
  expect(report.requests).toEqual({ drained: 0, abandoned: 0 });
});
