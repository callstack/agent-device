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

import { startDaemonRuntime } from './daemon-runtime.ts';

afterEach(() => {
  lifecycleEvents.length = 0;
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
