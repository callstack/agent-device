import fs from 'node:fs';
import { expect, test, vi } from 'vitest';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { clearAndroidObservationFixture } from '../../__tests__/support/android-observation-fixture.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import {
  daemonRuntimeDepsFixture,
  pluginRegistryFixture,
} from '../../__tests__/support/daemon-runtime-deps-fixture.ts';
import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import { providerCredentialsFixture } from '../../__tests__/support/provider-credentials-fixture.ts';
import { startDaemonRuntime } from './daemon-runtime.ts';
import {
  describeUnfinishedShutdownWork,
  reportDaemonClose,
  type ShutdownReport,
} from './server-shutdown.ts';

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
  await vi.waitFor(() => expect(reached).toHaveBeenCalled(), { timeout: 10_000 });

  const report = await runtime.close();

  expect(report.requests).toEqual({ drained: 0, abandoned: 1 });
  expect(fs.existsSync(paths.infoPath)).toBe(true);
  // A close nobody scoped for diagnostics (a signal, the idle reap) still leaves its record.
  expect(fs.readFileSync(paths.logPath, 'utf8')).toContain('daemon_shutdown_requests_abandoned');
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
      ...pluginRegistryFixture([stuck, done] as unknown as ProviderDeviceRuntime[]),
    }),
  });

  const report = await runtime.close();

  // The registry reports once, after its slowest plugin, so every active plugin is pending.
  expect(report.plugins).toEqual({ disposed: [], failed: [], pending: ['stuck', 'done'] });
  expect(report.requests).toEqual({ drained: 0, abandoned: 0 });
});

const cleanReport: ShutdownReport = {
  providerReleases: { completed: [], pending: [], unknown: [] },
  requests: { drained: 0, abandoned: 0 },
  runners: { stopped: [], handedOff: [] },
  sessions: { closed: 0, failed: 0 },
  plugins: { disposed: [], failed: [], pending: [] },
};

test('a clean close leaves nothing to report and an unfinished one names each piece of work', () => {
  expect(describeUnfinishedShutdownWork(cleanReport)).toEqual([]);

  const lines = describeUnfinishedShutdownWork({
    ...cleanReport,
    providerReleases: { completed: [], pending: ['lease-a'], unknown: ['lease-b'] },
    requests: { drained: 1, abandoned: 2 },
    sessions: { closed: 0, failed: 1 },
    plugins: {
      disposed: [],
      pending: ['stuck'],
      failed: [
        { provider: 'broken', step: 'dispose', error: { code: 'UNKNOWN', message: 'refused' } },
      ],
    },
  });

  expect(lines).toEqual([
    expect.stringContaining('2 request(s) ignored cancellation'),
    expect.stringContaining('plugin stuck was still shutting down'),
    expect.stringContaining('plugin broken failed to dispose: refused'),
    expect.stringContaining('lease release still pending for lease-a'),
    expect.stringContaining('outcome unknown for lease-b'),
    expect.stringContaining('1 session(s) failed to tear down'),
  ]);
});

test('the executable writes unfinished work to stderr after a close, and a clean close nothing', async () => {
  const clean: string[] = [];
  const unfinished: string[] = [];
  const failed: string[] = [];

  expect(
    await reportDaemonClose({
      closed: Promise.resolve(cleanReport),
      stderr: { write: (chunk) => clean.push(chunk) },
    }),
  ).toEqual({ failed: false });
  expect(
    await reportDaemonClose({
      closed: Promise.resolve({ ...cleanReport, requests: { drained: 0, abandoned: 1 } }),
      stderr: { write: (chunk) => unfinished.push(chunk) },
    }),
  ).toEqual({ failed: false });
  expect(
    await reportDaemonClose({
      closed: Promise.reject(new Error('close blew up')),
      stderr: { write: (chunk) => failed.push(chunk) },
    }),
  ).toEqual({ failed: true });

  expect(clean).toEqual([]);
  expect(unfinished).toEqual([expect.stringMatching(/1 request\(s\) ignored cancellation/)]);
  expect(failed.join('')).toContain('Daemon shutdown error: close blew up');
});
