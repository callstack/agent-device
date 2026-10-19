import fs from 'node:fs';
import path from 'node:path';
import * as transport from './transport.ts';
import { expect, test, vi } from 'vitest';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import {
  applicationLifecycleResourceFixture,
  daemonRuntimeDepsFixture,
  pluginRegistryFixture,
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
      ...pluginRegistryFixture([providerRuntime('stops', stop), providerRuntime('fails', failing)]),
      deviceRuntimeGateway: Object.freeze({
        ...lifecycleDeviceRuntimeGateway,
        applicationLifecycle: applicationLifecycleResourceFixture({
          detachForDaemonShutdown: async () => ['handed-off-device'],
          finalizeDaemonShutdown: async () => ['stopped-device'],
        }),
      }),
    }),
  });
  try {
    expect(process.listenerCount('SIGTERM')).toBe(signalListeners);

    const [first, second] = await Promise.all([runtime.close(), runtime.close()]);
    const third = await runtime.close();

    expect(second).toBe(first);
    expect(third).toBe(first);
    await expect(runtime.closed).resolves.toBe(first);
    expect(first.runners).toEqual({
      stopped: ['stopped-device'],
      handedOff: ['handed-off-device'],
    });
    expect(first.sessions).toEqual({ closed: 0, failed: 0 });
    expect(first.platformOwners).toBe('closed');
    expect(first.providerReleases).toEqual({ completed: [], pending: [], unknown: [] });
    expect(first.plugins.disposed).toEqual(['stops']);
    expect(first.plugins.failed).toEqual([
      {
        provider: 'fails',
        source: 'builtin',
        step: 'shutdown',
        error: expect.objectContaining({ message: 'provider refused to stop' }),
      },
    ]);
    expect(stop).toHaveBeenCalledOnce();
    expect(failing).toHaveBeenCalledOnce();
  } finally {
    await runtime.close();
  }
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
        ...pluginRegistryFixture([providerRuntime('stops', stop)]),
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

test('a shutdown step that rejects still releases the registration, lock and providers', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-close-failure-');
  const stop = vi.fn(async () => {});
  const clearLock = vi.fn(async () => {});
  const runtime = await startDaemonRuntime({
    host: hostFor(stateDir),
    ...silent,
    composeDeps: daemonRuntimeDepsFixture({
      ...pluginRegistryFixture([providerRuntime('stops', stop)]),
      ownerLifecycle: platformOwnerLifecycleFixture({ clearDaemonLockConfiguration: clearLock }),
      deviceRuntimeGateway: Object.freeze({
        ...lifecycleDeviceRuntimeGateway,
        applicationLifecycle: applicationLifecycleResourceFixture({
          finalizeDaemonShutdown: async () => {
            throw new Error('runner finalization failed');
          },
        }),
      }),
    }),
  });
  const paths = resolveDaemonPaths(stateDir);

  await expect(runtime.close()).rejects.toThrow('runner finalization failed');
  await expect(runtime.closed).rejects.toThrow('runner finalization failed');

  expect(stop).toHaveBeenCalledOnce();
  expect(clearLock).toHaveBeenCalledOnce();
  expect(fs.existsSync(paths.lockPath)).toBe(false);
  expect(fs.existsSync(paths.infoPath)).toBe(false);
});

test('failed HTTP setup rolls back an already listening socket', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-partial-listen-');
  const host = hostFor(stateDir);
  const createSocketServer = transport.createSocketServer;
  let acquired: ReturnType<typeof createSocketServer> | undefined;
  const spy = vi.spyOn(transport, 'createSocketServer').mockImplementation((handler) => {
    acquired = createSocketServer(handler);
    return acquired;
  });
  try {
    await expect(
      startDaemonRuntime({
        host: createTestHostEnvironment({
          env: {
            ...host.env,
            AGENT_DEVICE_DAEMON_SERVER_MODE: 'dual',
            AGENT_DEVICE_HTTP_AUTH_HOOK: path.join(stateDir, 'missing-hook.mjs'),
          },
        }),
        ...silent,
        composeDeps: daemonRuntimeDepsFixture(),
      }),
    ).rejects.toMatchObject({ details: { hookPath: path.join(stateDir, 'missing-hook.mjs') } });
    expect(acquired).toBeDefined();
    expect(acquired!.listening).toBe(false);
    expect(fs.existsSync(resolveDaemonPaths(stateDir).lockPath)).toBe(false);
  } finally {
    spy.mockRestore();
    acquired?.close();
  }
});

test('a relative HTTP auth hook uses the runtime host directory', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-host-auth-');
  fs.writeFileSync(
    path.join(stateDir, 'auth-hook.mjs'),
    "export default () => ({ ok: false, message: 'host hook refused' });",
  );
  const runtime = await startDaemonRuntime({
    host: createTestHostEnvironment({
      cwd: stateDir,
      env: { ...hostFor(stateDir).env, AGENT_DEVICE_HTTP_AUTH_HOOK: './auth-hook.mjs' },
    }),
    ...silent,
    composeDeps: daemonRuntimeDepsFixture(),
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${runtime.httpPort}/sessions/default/requests/abc123/diagnostics`,
      {
        headers: { authorization: `Bearer ${runtime.token}` },
      },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'host hook refused' });
  } finally {
    await runtime.close();
  }
});
