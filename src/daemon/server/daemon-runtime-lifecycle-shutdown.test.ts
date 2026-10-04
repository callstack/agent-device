import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

const lifecycleEvents = vi.hoisted(() => [] as string[]);

vi.mock('../../platform-runtime.ts', () => ({
  androidObservation: {},
  createRequestPlatformProviders: () => ({
    run: async (_context: unknown, task: () => Promise<unknown>) => await task(),
  }),
  createPlatformRuntimeGateway: () => ({
    applicationLifecycle: {
      recoverStartupResources: async () => {},
      detachForDaemonShutdown: async () => {
        lifecycleEvents.push('detach');
        // The real diagnostics module, unmocked: what this records is whether a diagnostic raised by
        // the handoff reaches disk at all, which only the shutdown's own scope can decide (#2681).
        const { emitDiagnostic } = await import('@agent-device/host-kit/diagnostics');
        emitDiagnostic({
          level: 'debug',
          phase: 'detach_scope_probe',
          data: { lane: 'physical_coredevice' },
        });
      },
      finalizeDaemonShutdown: async () => {
        lifecycleEvents.push('finalize');
      },
    },
    inspectFacts: async () => {
      throw new Error('unused');
    },
    bind: async () => {
      throw new Error('unused');
    },
    shutdown: async () => {
      lifecycleEvents.push('gateway-shutdown');
    },
  }),
  createPlatformDeviceInventoryGateways: () => ({}),
}));

vi.mock('../../provider-device-runtimes.ts', () => ({
  DEFAULT_PROVIDER_RUNTIME_REQUIRED_IDS: [],
  createDaemonProviderRuntimeComposition: async () => ({ runtimes: [], platformModules: [] }),
}));

const shutdownProbe = vi.hoisted(() => ({
  store: undefined as import('../session-store.ts').SessionStore | undefined,
  drain: undefined as (() => Promise<void>) | undefined,
  finalize: vi.fn(async () => {}),
}));
vi.mock('../session-store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session-store.ts')>();
  return {
    ...actual,
    SessionStore: class extends actual.SessionStore {
      constructor(...args: ConstructorParameters<typeof actual.SessionStore>) {
        super(...args);
        shutdownProbe.store = this;
      }
    },
  };
});
vi.mock('./server-shutdown.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./server-shutdown.ts')>();
  return {
    ...actual,
    closeDaemonServers: async (...args: Parameters<typeof actual.closeDaemonServers>) => {
      await actual.closeDaemonServers(...args);
      await shutdownProbe.drain?.();
    },
  };
});
vi.mock('../application-lifecycle-recovery.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../application-lifecycle-recovery.ts')>()),
  finalizeDaemonSessionApplicationLifecycle: shutdownProbe.finalize,
}));
import { acquireDeviceClaim } from '../device/device-claims.ts';
import { resolveDeviceClaimPath } from '../device/device-claim-paths.ts';
import { ANDROID_EMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import {
  isolatedDeviceClaimStores,
  retainOrphanedDeviceClaims,
} from '../../__tests__/test-utils/device-claim-store.ts';
import { startDaemonRuntime } from './daemon-runtime.ts';

afterEach(() => {
  lifecycleEvents.length = 0;
  shutdownProbe.drain = undefined;
  shutdownProbe.finalize.mockReset();
});

test('daemon shutdown detaches before session teardown and force-finalizes only after gateway resources', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-lifecycle-shutdown-');
  const exits: number[] = [];
  const startupErrors: string[] = [];
  try {
    const runtime = await startDaemonRuntime({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
      },
      exit: (code) => exits.push(code),
      registerProcessHandlers: false,
      stderr: { write: (chunk) => startupErrors.push(chunk) },
      stdout: { write: () => {} },
    });
    expect(runtime, startupErrors.join('')).not.toBeNull();

    await Promise.all([runtime?.shutdown(), runtime?.shutdown()]);

    expect(lifecycleEvents).toEqual(['detach', 'gateway-shutdown', 'finalize']);
    expect(exits).toEqual([0]);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a SIGTERM shutdown gives the handoff a diagnostics scope to write its reasons into', async () => {
  // Without the scope, `emitDiagnostic` is a no-op outside a request and every detach reason —
  // including "why did this runner get killed instead of handed off" — disappears with the daemon.
  const stateDir = mkdtempForTestSync('agent-device-daemon-detach-diagnostics-');
  try {
    const runtime = await startDaemonRuntime({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
      },
      exit: () => {},
      registerProcessHandlers: false,
      stderr: { write: () => {} },
      stdout: { write: () => {} },
    });
    expect(runtime).not.toBeNull();

    await runtime?.shutdown();

    const daemonLog = fs.readFileSync(path.join(stateDir, 'daemon.log'), 'utf8');
    expect(daemonLog).toMatch(/"phase":"detach_scope_probe"/);
    expect(daemonLog).toMatch(/"lane":"physical_coredevice"/);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

const claimStores = isolatedDeviceClaimStores('daemon-drain-admission-');

test('shutdown includes drain publications, releases their claims and refuses post-snapshot publication', async () => {
  const { stateDir } = claimStores();
  const runtime = await startDaemonRuntime({
    env: {
      ...process.env,
      AGENT_DEVICE_STATE_DIR: stateDir,
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
      AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
    },
    exit: () => {},
    registerProcessHandlers: false,
    stderr: { write: () => {} },
    stdout: { write: () => {} },
  });
  expect(runtime).not.toBeNull();
  const store = shutdownProbe.store!;
  const acquired = await acquireDeviceClaim({
    device: ANDROID_EMULATOR,
    session: 'draining',
    workspace: stateDir,
    stateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });
  if (acquired.status !== 'acquired') throw new Error('Expected acquired claim');
  const session = {
    name: 'draining',
    device: ANDROID_EMULATOR,
    createdAt: Date.now(),
    actions: [],
    deviceClaim: acquired.ownership,
  };
  shutdownProbe.drain = async () => {
    store.publish('draining', session);
  };
  shutdownProbe.finalize.mockImplementationOnce(async () => {
    expect(() => store.publish('late', { ...session, name: 'late' })).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'daemon_shutting_down' }),
      }),
    );
  });
  try {
    await runtime!.shutdown();
    expect(shutdownProbe.finalize).toHaveBeenCalledOnce();
    expect(store.lookup('draining')).toBeUndefined();
    expect(store.lookup('late')).toBeUndefined();
    expect(fs.existsSync(resolveDeviceClaimPath(acquired.ownership.deviceKey))).toBe(false);
  } finally {
    await runtime!.shutdown();
  }
});
