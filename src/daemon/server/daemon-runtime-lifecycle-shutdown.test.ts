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

import { startDaemonRuntime, teardownDaemonSessionForShutdown } from './daemon-runtime.ts';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';

afterEach(() => {
  lifecycleEvents.length = 0;
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
