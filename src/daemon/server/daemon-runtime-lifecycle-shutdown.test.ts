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
  dispatch: undefined as import('../daemon-request.ts').DaemonInvokeFn | undefined,
  closeTimeout: undefined as number | undefined,
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
      await actual.closeDaemonServers(args[0], shutdownProbe.closeTimeout ?? args[1]);
      await shutdownProbe.drain?.();
    },
  };
});
vi.mock('../request-router.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../request-router.ts')>();
  return {
    ...actual,
    createRequestHandler: (...args: Parameters<typeof actual.createRequestHandler>) => {
      const dispatch = actual.createRequestHandler(...args);
      return async (...request: Parameters<typeof dispatch>) =>
        await (shutdownProbe.dispatch ?? dispatch)(...request);
    },
  };
});
vi.mock('../application-lifecycle-recovery.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../application-lifecycle-recovery.ts')>()),
  finalizeDaemonSessionApplicationLifecycle: shutdownProbe.finalize,
}));
const leaseProbe = vi.hoisted(() => ({
  registries: [] as import('../lease-registry.ts').LeaseRegistry[],
  released: [] as import('@agent-device/contracts/device').DeviceLease[],
}));

vi.mock('../lease-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lease-registry.ts')>();
  class RecordedLeaseRegistry extends actual.LeaseRegistry {
    constructor(...args: ConstructorParameters<typeof actual.LeaseRegistry>) {
      super(...args);
      leaseProbe.registries.push(this);
    }
  }
  return { ...actual, LeaseRegistry: RecordedLeaseRegistry };
});

vi.mock('../provider-lease-expiry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../provider-lease-expiry.ts')>();
  return {
    ...actual,
    createExpiredProviderLeaseReleaser: (
      ...args: Parameters<typeof actual.createExpiredProviderLeaseReleaser>
    ) => {
      const releaser = actual.createExpiredProviderLeaseReleaser(...args);
      return {
        ...releaser,
        release: async (lease: import('@agent-device/contracts/device').DeviceLease) => {
          leaseProbe.released.push(lease);
          await releaser.release(lease);
        },
      };
    },
  };
});

import { acquireDeviceClaim } from '../device/device-claims.ts';
import { resolveDeviceClaimPath } from '../device/device-claim-paths.ts';
import { ANDROID_EMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import {
  isolatedDeviceClaimStores,
  retainOrphanedDeviceClaims,
} from '../../__tests__/test-utils/device-claim-store.ts';
import { sendRequest } from '../../daemon-client/daemon-client-transport.ts';
import { resolveDaemonPaths } from '../../daemon-resolution.ts';
import { startDaemonRuntime, teardownDaemonSessionForShutdown } from './daemon-runtime.ts';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';

afterEach(() => {
  lifecycleEvents.length = 0;
  shutdownProbe.drain = undefined;
  shutdownProbe.dispatch = undefined;
  shutdownProbe.closeTimeout = undefined;
  shutdownProbe.finalize.mockReset();
  leaseProbe.registries.length = 0;
  leaseProbe.released.length = 0;
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
  try {
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
    let refusal: unknown;
    shutdownProbe.finalize.mockImplementationOnce(async () => {
      try {
        store.publish('late', { ...session, name: 'late' });
      } catch (error) {
        refusal = error;
      }
    });
    await runtime!.shutdown();
    expect(shutdownProbe.finalize).toHaveBeenCalledOnce();
    expect(refusal).toMatchObject({ details: { reason: 'daemon_shutting_down' } });
    expect(store.lookup('draining')).toBeUndefined();
    expect(store.lookup('late')).toBeUndefined();
    expect(fs.existsSync(resolveDeviceClaimPath(acquired.ownership.deviceKey))).toBe(false);
  } finally {
    await runtime?.shutdown();
  }
});

test('shutdown joins dispatch completion after force-closing the client before taking its snapshot', async () => {
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
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let closed!: () => void;
  const serversClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  let request: Promise<unknown> | undefined;
  let shutdown: Promise<void> | undefined;
  try {
    expect(runtime).not.toBeNull();
    const store = shutdownProbe.store!;
    const acquired = await acquireDeviceClaim({
      device: ANDROID_EMULATOR,
      session: 'dispatching',
      workspace: stateDir,
      stateDir,
      reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
    });
    if (acquired.status !== 'acquired') throw new Error('Expected acquired claim');
    let publicationError: unknown;
    shutdownProbe.dispatch = async () => {
      entered();
      await held;
      try {
        store.publish('dispatching', {
          name: 'dispatching',
          device: ANDROID_EMULATOR,
          createdAt: Date.now(),
          actions: [],
          deviceClaim: acquired.ownership,
        });
      } catch (error) {
        publicationError = error;
      }
      return { ok: true };
    };
    request = sendRequest(
      { httpPort: runtime!.httpPort, pid: process.pid, token: runtime!.token },
      {
        token: runtime!.token,
        session: 'dispatching',
        command: 'open',
        positionals: [],
        flags: {},
      },
      'http',
      resolveDaemonPaths(stateDir),
      10_000,
    ).catch((error: unknown) => error);
    await started;
    shutdownProbe.closeTimeout = 1;
    shutdownProbe.drain = async () => {
      closed();
    };
    shutdown = runtime!.shutdown();
    await serversClosed;
    await new Promise((resolve) => setImmediate(resolve));
    expect(lifecycleEvents).not.toContain('detach');
    expect(shutdownProbe.finalize).not.toHaveBeenCalled();
    release();
    await shutdown;
    await request;
    expect(publicationError).toBeUndefined();
    expect(shutdownProbe.finalize).toHaveBeenCalledOnce();
    expect(store.lookup('dispatching')).toBeUndefined();
    expect(fs.existsSync(resolveDeviceClaimPath(acquired.ownership.deviceKey))).toBe(false);
  } finally {
    release();
    await request;
    await shutdown;
    await runtime?.shutdown();
  }
});
test.each([false, true])(
  'shutdown forwards only the addressed lifetime’s runtime hints, retired=%s',
  async (retired) => {
    const sessionStore = makeSessionStore('shutdown-scoped-hints-');
    const address = 'cwd:shutdown-hints:default';
    const ref = sessionStore.publish(address, makeIosSession('default'));
    const publicRef = sessionStore.publish('default', makeIosSession('default'));
    sessionStore.setRuntimeHints(address, { metroHost: 'scoped.example', metroPort: 8082 });
    sessionStore.setRuntimeHints('default', { metroHost: 'public.example', metroPort: 8083 });
    let successor;
    if (retired) {
      sessionStore.retire(ref);
      successor = sessionStore.publish(address, makeIosSession('default'));
      sessionStore.setRuntimeHints(address, { metroHost: 'successor.example', metroPort: 8084 });
    }
    const finalizeApplicationLifecycle = vi.fn(async () => {});

    await teardownDaemonSessionForShutdown({
      ref,
      sessionStore,
      stderr: { write: () => {} },
      finalizeApplicationLifecycle,
    });

    expect(finalizeApplicationLifecycle).toHaveBeenCalledWith(
      ref.session,
      retired ? {} : { metroHost: 'scoped.example', metroPort: '8082' },
    );
    expect(sessionStore.resolveCurrent(publicRef)).toBe(publicRef.session);
    expect(sessionStore.getRuntimeHints('default')).toEqual({
      metroHost: 'public.example',
      metroPort: 8083,
    });
    if (successor) {
      expect(sessionStore.resolveCurrent(successor)).toBe(successor.session);
      expect(sessionStore.getRuntimeHints(address)).toEqual({
        metroHost: 'successor.example',
        metroPort: 8084,
      });
    } else {
      expect(sessionStore.lookup(address)).toBeUndefined();
    }
  },
);

test('daemon shutdown releases a session lease whose session teardown rejects', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-session-lease-shutdown-');
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
  const [leaseRegistry] = leaseProbe.registries;
  const lease = leaseRegistry!.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'limrun',
  });
  shutdownProbe.store!.publish('bound', {
    ...makeIosSession('bound'),
    lease: { leaseId: lease.leaseId, tenantId: lease.tenantId, runId: lease.runId },
  });
  shutdownProbe.finalize.mockRejectedValueOnce(new Error('teardown failed'));

  await runtime?.shutdown();

  expect(shutdownProbe.finalize).toHaveBeenCalledOnce();
  expect(leaseProbe.released).toEqual([lease]);
  expect(leaseRegistry!.listActiveLeases()).toEqual([]);
});

test('daemon shutdown releases a retainOnClose lease that no session holds', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-retained-lease-shutdown-');
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
    const [leaseRegistry] = leaseProbe.registries;
    const lease = leaseRegistry!.allocateLease({
      tenantId: 'tenant-a',
      runId: 'run-1',
      leaseProvider: 'limrun',
      retainOnClose: true,
    });

    await runtime?.shutdown();

    expect(leaseProbe.released).toEqual([lease]);
    expect(leaseRegistry!.listActiveLeases()).toEqual([]);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
