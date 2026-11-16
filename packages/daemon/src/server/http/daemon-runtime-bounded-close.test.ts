import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { lifecycleDeviceRuntimeGateway } from '../../__tests__/support/test-device-runtime-gateway.ts';
import { afterEach, expect, test, vi } from 'vitest';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { appLogResourceStore } from '@agent-device/capture-kit/app-log-durable-resource';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { runtimeSlot } from '@agent-device/host-kit/runtime-slots';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { clearAndroidObservationFixture } from '../../__tests__/support/android-observation-fixture.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import {
  daemonRuntimeDepsFixture,
  applicationLifecycleResourceFixture,
  platformOwnerLifecycleFixture,
  pluginRegistryFixture,
} from '../../__tests__/support/daemon-runtime-deps-fixture.ts';
import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import { providerCredentialsFixture } from '../../__tests__/support/provider-credentials-fixture.ts';
import { startDaemonRuntime } from './daemon-runtime.ts';
import {
  createPluginClose,
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
  platformOwners: 'closed',
  plugins: { disposed: [], failed: [], pending: [] },
};

test('a clean close leaves nothing to report and an unfinished one names each piece of work', () => {
  expect(describeUnfinishedShutdownWork(cleanReport)).toEqual([]);

  const lines = describeUnfinishedShutdownWork({
    ...cleanReport,
    providerReleases: { completed: [], pending: ['lease-a'], unknown: ['lease-b'] },
    requests: { drained: 1, abandoned: 2 },
    platformOwners: 'failed',
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
    expect.stringContaining('platform owner shutdown failed'),
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

  for (const [platformOwners, expectedFailed, message] of [
    ['pending', false, 'platform owners were still shutting down'],
    ['failed', true, 'platform owner shutdown failed'],
  ] as const) {
    const lines: string[] = [];
    expect(
      await reportDaemonClose({
        closed: Promise.resolve({ ...cleanReport, platformOwners }),
        stderr: { write: (chunk) => lines.push(chunk) },
      }),
    ).toEqual({ failed: expectedFailed });
    expect(lines).toEqual([expect.stringContaining(message)]);
  }

  expect(clean).toEqual([]);
  expect(unfinished).toEqual([expect.stringMatching(/1 request\(s\) ignored cancellation/)]);
  expect(failed.join('')).toContain('Daemon shutdown error: close blew up');
});

test('unfinished platform owner shutdown is bounded, reports pending and retains ownership', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-bounded-owner-');
  let finishOwner!: () => void;
  const ownerClosed = new Promise<void>((resolve) => {
    finishOwner = resolve;
  });
  const clearLock = vi.fn(async () => {});
  const pluginShutdown = vi.fn(async () => []);
  // The slot lives on the runtime's one entered store, so its disposer runs exactly when that
  // store is disposed (#3794): it stands in for the per-runtime state the close must not drop
  // while work is unfinished.
  const disposeState = vi.fn();
  const heldSlot = Symbol('bounded-close-held-state');
  const runtime = await startDaemonRuntime({
    host: hostFor(stateDir),
    ...silent,
    shutdownBudgets: { ownerMs: 20 },
    composeDeps: async (input) => {
      runtimeSlot(heldSlot, () => ({}), disposeState);
      return await daemonRuntimeDepsFixture({
        deviceRuntimeGateway: {
          ...lifecycleDeviceRuntimeGateway,
          applicationLifecycle: applicationLifecycleResourceFixture(),
          shutdown: () => ownerClosed,
        },
        ownerLifecycle: platformOwnerLifecycleFixture({ clearDaemonLockConfiguration: clearLock }),
        shutdownProviderRuntimes: pluginShutdown,
      })(input);
    },
  });
  const closing = runtime.close();
  try {
    const report = await Promise.race([closing, delay(1_000, null)]);
    expect(report).not.toBeNull();
    expect(report!.platformOwners).toBe('pending');
    await expect(runtime.closed).resolves.toBe(report);
    expect(pluginShutdown).toHaveBeenCalledOnce();
    expect(clearLock).not.toHaveBeenCalled();
    expect(disposeState).not.toHaveBeenCalled();
    const paths = resolveDaemonPaths(stateDir);
    expect(fs.existsSync(paths.lockPath)).toBe(true);
    expect(fs.existsSync(paths.infoPath)).toBe(true);
    expect(describeUnfinishedShutdownWork(report!)).toEqual([
      expect.stringContaining('platform owners were still shutting down'),
    ]);
  } finally {
    finishOwner();
    await closing;
  }
});

test('a clean close disposes the state composition declared in the entered handle', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-bounded-close-clean-');
  const disposeState = vi.fn();
  const heldSlot = Symbol('bounded-close-clean-state');
  const runtime = await startDaemonRuntime({
    host: hostFor(stateDir),
    ...silent,
    composeDeps: async (input) => {
      // The slot is declared through the store the runtime entered, so it only exists when
      // composition runs inside the handle. The disposer running once at close proves both
      // halves: composition entered the handle, and the close disposed that state.
      runtimeSlot(heldSlot, () => ({}), disposeState);
      return await daemonRuntimeDepsFixture({})(input);
    },
  });

  const report = await runtime.close();

  expect(report.platformOwners).toBe('closed');
  expect(disposeState).toHaveBeenCalledOnce();
});

afterEach(() => {
  vi.useRealTimers();
});

function writeStaleClaim(claimsDir: string, ownerStateDir: string, deviceKey: string): string {
  const claimPath = path.join(
    claimsDir,
    `${crypto.createHash('sha256').update(deviceKey).digest('hex')}.json`,
  );
  fs.mkdirSync(claimsDir, { recursive: true });
  fs.writeFileSync(
    claimPath,
    JSON.stringify({
      schemaVersion: 3,
      claimOwnerKind: 'open-session',
      deviceKey,
      device: { family: 'android', id: 'emulator-5554', name: 'Pixel', kind: 'emulator' },
      session: 'dead-session',
      workspace: '/worktrees/dead',
      stateDir: ownerStateDir,
      ownerPid: 999_999_999,
      ownerStartTime: 'dead-start',
      ownerToken: 'claim-token',
      createdAtMs: 1,
      updatedAtMs: 1,
    }),
  );
  return claimPath;
}

test('daemon close awaits a post-budget claim-recovery disposal and keeps unfinished work while pending', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const stateDir = mkdtempForTestSync('agent-device-daemon-recovery-pending-');
  const ownerStateDir = mkdtempForTestSync('agent-device-daemon-recovery-owner-');
  const claimsDir = mkdtempForTestSync('agent-device-daemon-recovery-claims-');
  const deviceKey = 'local:android:none:emulator-5554';
  const claimPath = writeStaleClaim(claimsDir, ownerStateDir, deviceKey);
  const claimBytes = fs.readFileSync(claimPath, 'utf8');

  let enterRecoveryShutdown!: () => void;
  const recoveryShutdownEntered = new Promise<void>((resolve) => {
    enterRecoveryShutdown = resolve;
  });
  let finishRecoveryShutdown!: () => void;
  const recoveryShutdownClosed = new Promise<void>((resolve) => {
    finishRecoveryShutdown = resolve;
  });
  const clearLock = vi.fn(async () => {});
  const disposeState = vi.fn();
  const heldSlot = Symbol('bounded-close-recovery-disposal');

  const starting = startDaemonRuntime({
    host: createTestHostEnvironment({
      env: {
        ...hostFor(stateDir).env,
        AGENT_DEVICE_CLAIMS_DIR: claimsDir,
      },
    }),
    ...silent,
    shutdownBudgets: { ownerMs: 20 },
    composeDeps: async (input) => {
      runtimeSlot(heldSlot, () => ({}), disposeState);
      return await daemonRuntimeDepsFixture({
        ownerLifecycle: platformOwnerLifecycleFixture({ clearDaemonLockConfiguration: clearLock }),
        claimRecoveryGateway: () =>
          Object.freeze({
            ...lifecycleDeviceRuntimeGateway,
            shutdown: async () => {
              enterRecoveryShutdown();
              await recoveryShutdownClosed;
            },
          }),
      })(input);
    },
  });

  await recoveryShutdownEntered;
  await vi.advanceTimersByTimeAsync(5_000);
  const runtime = await starting;
  expect(fs.readFileSync(claimPath, 'utf8')).toBe(claimBytes);

  const closing = runtime.close();
  try {
    await vi.advanceTimersByTimeAsync(20);
    const report = await closing;
    expect(report.requests).toEqual({ drained: 0, abandoned: 0 });
    expect(report.platformOwners).toBe('pending');
    expect(clearLock).not.toHaveBeenCalled();
    expect(disposeState).not.toHaveBeenCalled();
    const paths = resolveDaemonPaths(stateDir);
    expect(fs.existsSync(paths.lockPath)).toBe(true);
    expect(fs.existsSync(paths.infoPath)).toBe(true);
    expect(describeUnfinishedShutdownWork(report)).toEqual([
      expect.stringContaining('platform owners were still shutting down'),
    ]);
  } finally {
    finishRecoveryShutdown();
    await closing;
  }
});

test('daemon close completes cleanly once a post-budget claim-recovery disposal settles inside the owner budget', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const stateDir = mkdtempForTestSync('agent-device-daemon-recovery-settled-');
  const ownerStateDir = mkdtempForTestSync('agent-device-daemon-recovery-settled-owner-');
  const claimsDir = mkdtempForTestSync('agent-device-daemon-recovery-settled-claims-');
  writeStaleClaim(claimsDir, ownerStateDir, 'local:android:none:emulator-5554');

  let enterRecoveryShutdown!: () => void;
  const recoveryShutdownEntered = new Promise<void>((resolve) => {
    enterRecoveryShutdown = resolve;
  });
  let finishRecoveryShutdown!: () => void;
  const recoveryShutdownClosed = new Promise<void>((resolve) => {
    finishRecoveryShutdown = resolve;
  });
  let enterOwnerShutdown!: () => void;
  const ownerShutdownEntered = new Promise<void>((resolve) => {
    enterOwnerShutdown = resolve;
  });
  const clearLock = vi.fn(async () => {});
  const finalizeShutdown = vi.fn(async (): Promise<readonly string[]> => []);
  const pluginShutdown = vi.fn(async () => []);
  const disposeState = vi.fn();
  const heldSlot = Symbol('bounded-close-recovery-settled');

  const starting = startDaemonRuntime({
    host: createTestHostEnvironment({
      env: {
        ...hostFor(stateDir).env,
        AGENT_DEVICE_CLAIMS_DIR: claimsDir,
      },
    }),
    ...silent,
    shutdownBudgets: { ownerMs: 100 },
    composeDeps: async (input) => {
      runtimeSlot(heldSlot, () => ({}), disposeState);
      return await daemonRuntimeDepsFixture({
        deviceRuntimeGateway: Object.freeze({
          ...lifecycleDeviceRuntimeGateway,
          applicationLifecycle: applicationLifecycleResourceFixture({
            finalizeDaemonShutdown: finalizeShutdown,
          }),
          shutdown: async () => {
            enterOwnerShutdown();
          },
        }),
        ownerLifecycle: platformOwnerLifecycleFixture({ clearDaemonLockConfiguration: clearLock }),
        shutdownProviderRuntimes: pluginShutdown,
        claimRecoveryGateway: () =>
          Object.freeze({
            ...lifecycleDeviceRuntimeGateway,
            shutdown: async () => {
              enterRecoveryShutdown();
              await recoveryShutdownClosed;
            },
          }),
      })(input);
    },
  });

  await recoveryShutdownEntered;
  await vi.advanceTimersByTimeAsync(5_000);
  const runtime = await starting;

  let closed = false;
  const closing = runtime.close().then((report) => {
    closed = true;
    return report;
  });
  await ownerShutdownEntered;
  await vi.advanceTimersByTimeAsync(10);
  expect(closed).toBe(false);
  expect(pluginShutdown).not.toHaveBeenCalled();
  expect(finalizeShutdown).not.toHaveBeenCalled();

  finishRecoveryShutdown();
  const report = await closing;

  expect(report.requests).toEqual({ drained: 0, abandoned: 0 });
  expect(report.platformOwners).toBe('closed');
  expect(pluginShutdown).toHaveBeenCalledOnce();
  expect(finalizeShutdown).toHaveBeenCalledOnce();
  expect(clearLock).toHaveBeenCalledOnce();
  expect(disposeState).toHaveBeenCalledOnce();
  const paths = resolveDaemonPaths(stateDir);
  expect(fs.existsSync(paths.lockPath)).toBe(false);
  expect(fs.existsSync(paths.infoPath)).toBe(false);
});

test('daemon close during an in-flight request recovery disposal grace still tracks pending disposal', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-close-mid-grace-');
  const ownerStateDir = mkdtempForTestSync('agent-device-daemon-close-mid-grace-owner-');
  const claimsDir = mkdtempForTestSync('agent-device-daemon-close-mid-grace-claims-');
  const deviceKey = 'local:android:none:emulator-5554';

  let enterRecoveryShutdown!: () => void;
  const recoveryShutdownEntered = new Promise<void>((resolve) => {
    enterRecoveryShutdown = resolve;
  });
  let finishRecoveryShutdown!: () => void;
  const recoveryShutdownClosed = new Promise<void>((resolve) => {
    finishRecoveryShutdown = resolve;
  });
  const clearLock = vi.fn(async () => {});
  const disposeState = vi.fn();
  const heldSlot = Symbol('bounded-close-mid-grace');

  const runtime = await startDaemonRuntime({
    host: createTestHostEnvironment({
      env: {
        ...hostFor(stateDir).env,
        AGENT_DEVICE_CLAIMS_DIR: claimsDir,
      },
    }),
    ...silent,
    shutdownBudgets: { requestDrainMs: 20, ownerMs: 20 },
    composeDeps: async (input) => {
      runtimeSlot(heldSlot, () => ({}), disposeState);
      return await daemonRuntimeDepsFixture((depsInput) => ({
        ownerLifecycle: platformOwnerLifecycleFixture({ clearDaemonLockConfiguration: clearLock }),
        claimRecoveryGateway: () =>
          Object.freeze({
            ...lifecycleDeviceRuntimeGateway,
            shutdown: async () => {
              enterRecoveryShutdown();
              await recoveryShutdownClosed;
            },
          }),
        requestRouter: Object.freeze({
          deviceInventoryGateways: createTestDeviceInventoryGateways({
            local: async () => [
              {
                platform: 'android',
                id: 'emulator-5554',
                name: 'Pixel',
                kind: 'emulator',
                target: 'mobile',
                booted: true,
              },
            ],
          }),
          platformServices: daemonPlatformServicesFixture(),
          androidObservation: clearAndroidObservationFixture,
          providerCredentials: providerCredentialsFixture(depsInput.host.env, depsInput.baseDir),
          createCommandSurface: fakeCreateCommandSurface,
        }),
      }))(input);
    },
  });

  writeStaleClaim(claimsDir, ownerStateDir, deviceKey);
  const openRequest = fetch(`http://127.0.0.1:${runtime.httpPort}/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${runtime.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'open-mid-grace',
      method: 'agent_device.command',
      params: {
        session: 'default',
        command: 'open',
        positionals: [],
        flags: { platform: 'android', serial: 'emulator-5554' },
        meta: { requestId: 'open-mid-grace' },
      },
    }),
  }).catch(() => undefined);

  await recoveryShutdownEntered;
  const closing = runtime.close();
  try {
    const report = await closing;
    expect(report.requests).toEqual({ drained: 0, abandoned: 1 });
    expect(report.platformOwners).toBe('pending');
    expect(clearLock).not.toHaveBeenCalled();
    expect(disposeState).not.toHaveBeenCalled();
    const paths = resolveDaemonPaths(stateDir);
    expect(fs.existsSync(paths.lockPath)).toBe(true);
    expect(fs.existsSync(paths.infoPath)).toBe(true);
  } finally {
    finishRecoveryShutdown();
    await Promise.allSettled([closing, openRequest]);
  }
});

test('daemon close awaits a recovery disposal that starts after the owner shutdown phase begins', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-close-late-compose-');
  const ownerStateDir = mkdtempForTestSync('agent-device-daemon-close-late-compose-owner-');
  const claimsDir = mkdtempForTestSync('agent-device-daemon-close-late-compose-claims-');
  const deviceKey = 'local:android:none:emulator-5554';

  let enterReconcile!: () => void;
  const reconcileEntered = new Promise<void>((resolve) => {
    enterReconcile = resolve;
  });
  let enterOwnerShutdown!: () => void;
  const ownerShutdownEntered = new Promise<void>((resolve) => {
    enterOwnerShutdown = resolve;
  });
  let finishRootShutdown!: () => void;
  const rootShutdownClosed = new Promise<void>((resolve) => {
    finishRootShutdown = resolve;
  });
  let enterRecoveryShutdown!: () => void;
  const recoveryShutdownEntered = new Promise<void>((resolve) => {
    enterRecoveryShutdown = resolve;
  });
  let finishRecoveryShutdown!: () => void;
  const recoveryShutdownClosed = new Promise<void>((resolve) => {
    finishRecoveryShutdown = resolve;
  });
  const clearLock = vi.fn(async () => {});
  const disposeState = vi.fn();
  const heldSlot = Symbol('bounded-close-late-compose');

  const runtime = await startDaemonRuntime({
    host: createTestHostEnvironment({
      env: {
        ...hostFor(stateDir).env,
        AGENT_DEVICE_CLAIMS_DIR: claimsDir,
      },
    }),
    ...silent,
    shutdownBudgets: { requestDrainMs: 20, ownerMs: 40 },
    composeDeps: async (input) => {
      runtimeSlot(heldSlot, () => ({}), disposeState);
      return await daemonRuntimeDepsFixture((depsInput) => ({
        deviceRuntimeGateway: Object.freeze({
          ...lifecycleDeviceRuntimeGateway,
          applicationLifecycle: applicationLifecycleResourceFixture(),
          shutdown: async () => {
            enterOwnerShutdown();
            await rootShutdownClosed;
          },
        }),
        ownerLifecycle: platformOwnerLifecycleFixture({ clearDaemonLockConfiguration: clearLock }),
        claimRecoveryGateway: () =>
          Object.freeze({
            ...lifecycleDeviceRuntimeGateway,
            bind: async () => {
              enterReconcile();
              await ownerShutdownEntered;
              throw new Error('reconcile interrupted after owner shutdown began');
            },
            shutdown: async () => {
              enterRecoveryShutdown();
              await recoveryShutdownClosed;
            },
          }),
        requestRouter: Object.freeze({
          deviceInventoryGateways: createTestDeviceInventoryGateways({
            local: async () => [
              {
                platform: 'android',
                id: 'emulator-5554',
                name: 'Pixel',
                kind: 'emulator',
                target: 'mobile',
                booted: true,
              },
            ],
          }),
          platformServices: daemonPlatformServicesFixture(),
          androidObservation: clearAndroidObservationFixture,
          providerCredentials: providerCredentialsFixture(depsInput.host.env, depsInput.baseDir),
          createCommandSurface: fakeCreateCommandSurface,
        }),
      }))(input);
    },
  });

  appLogResourceStore.write(
    appLogResourceStore.resolvePath(path.join(ownerStateDir, 'sessions', 'dead-session')),
    createDurableResourceEnvelope({
      resourceKind: 'app-log',
      sessionId: 'dead-session',
      device: { id: 'emulator-5554', family: 'android', kind: 'emulator' },
      owner: localRuntimeOwner('android'),
      fence: { token: 'fence', generation: 1 },
      lifecycle: 'open',
      descriptor: { version: 1, body: { pid: 123 } },
    }),
  );
  writeStaleClaim(claimsDir, ownerStateDir, deviceKey);
  const openRequest = fetch(`http://127.0.0.1:${runtime.httpPort}/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${runtime.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'open-late-compose',
      method: 'agent_device.command',
      params: {
        session: 'default',
        command: 'open',
        positionals: [],
        flags: { platform: 'android', serial: 'emulator-5554' },
        meta: { requestId: 'open-late-compose' },
      },
    }),
  }).catch(() => undefined);

  await reconcileEntered;
  const closing = runtime.close();
  try {
    await recoveryShutdownEntered;
    finishRootShutdown();
    const report = await closing;
    expect(report.requests).toEqual({ drained: 0, abandoned: 1 });
    expect(report.platformOwners).toBe('pending');
    expect(clearLock).not.toHaveBeenCalled();
    expect(disposeState).not.toHaveBeenCalled();
    const paths = resolveDaemonPaths(stateDir);
    expect(fs.existsSync(paths.lockPath)).toBe(true);
    expect(fs.existsSync(paths.infoPath)).toBe(true);
  } finally {
    finishRootShutdown();
    finishRecoveryShutdown();
    await Promise.allSettled([closing, openRequest]);
  }
});

test('daemon close reports pending when root gateway rejects while a recovery disposal outlives ownerMs', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const stateDir = mkdtempForTestSync('agent-device-daemon-recovery-and-gateway-fail-');
  const ownerStateDir = mkdtempForTestSync('agent-device-daemon-recovery-and-gateway-fail-owner-');
  const claimsDir = mkdtempForTestSync('agent-device-daemon-recovery-and-gateway-fail-claims-');
  writeStaleClaim(claimsDir, ownerStateDir, 'local:android:none:emulator-5554');

  let enterRecoveryShutdown!: () => void;
  const recoveryShutdownEntered = new Promise<void>((resolve) => {
    enterRecoveryShutdown = resolve;
  });
  let finishRecoveryShutdown!: () => void;
  const recoveryShutdownClosed = new Promise<void>((resolve) => {
    finishRecoveryShutdown = resolve;
  });

  const starting = startDaemonRuntime({
    host: createTestHostEnvironment({
      env: {
        ...hostFor(stateDir).env,
        AGENT_DEVICE_CLAIMS_DIR: claimsDir,
      },
    }),
    ...silent,
    shutdownBudgets: { ownerMs: 20 },
    composeDeps: daemonRuntimeDepsFixture({
      deviceRuntimeGateway: Object.freeze({
        ...lifecycleDeviceRuntimeGateway,
        applicationLifecycle: applicationLifecycleResourceFixture(),
        shutdown: async () => {
          throw new Error('root gateway refused shutdown');
        },
      }),
      claimRecoveryGateway: () =>
        Object.freeze({
          ...lifecycleDeviceRuntimeGateway,
          shutdown: async () => {
            enterRecoveryShutdown();
            await recoveryShutdownClosed;
          },
        }),
    }),
  });

  await recoveryShutdownEntered;
  await vi.advanceTimersByTimeAsync(5_000);
  const runtime = await starting;

  const closing = runtime.close();
  try {
    await vi.advanceTimersByTimeAsync(20);
    const report = await closing;
    expect(report.platformOwners).toBe('pending');
    const paths = resolveDaemonPaths(stateDir);
    expect(fs.readFileSync(paths.logPath, 'utf8')).toContain(
      'daemon_shutdown_platform_owner_failed',
    );
  } finally {
    finishRecoveryShutdown();
    await closing;
  }
});

test('only registered cleanup owners stay pending after a lazy backend failure', async () => {
  vi.useFakeTimers();
  try {
    const inventory: import('@agent-device/contracts/plugin-inventory').PluginInventoryEntry[] = [
      {
        backend: 'maestro',
        source: 'store',
        state: 'active',
        credentials: { variables: [], byBackend: {} },
      },
      {
        backend: 'maestro',
        source: 'embedder',
        state: 'failed',
        error: { code: 'INVALID_ARGS', message: 'duplicate', reason: 'duplicate_replay_backend' },
        credentials: { variables: [], byBackend: {} },
      },
      {
        backend: 'rejected',
        source: 'store',
        state: 'failed',
        error: { code: 'COMMAND_FAILED', message: 'setup failed', reason: 'plugin_setup_failed' },
        credentials: { variables: [], byBackend: {} },
      },
    ];
    const owner = createPluginClose({
      close: () => new Promise(() => {}),
      timeoutMs: 50,
      inventory,
    });
    inventory[0] = {
      ...inventory[0]!,
      state: 'failed',
      error: { code: 'COMMAND_FAILED', message: 'load failed', reason: 'plugin_load_failed' },
    };
    const close = owner.close();
    await vi.advanceTimersByTimeAsync(50);
    expect(await close).toEqual({ disposed: [], failed: [], pending: ['replay-backend:maestro'] });
  } finally {
    vi.useRealTimers();
  }
});
