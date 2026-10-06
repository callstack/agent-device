import fs from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import { setActiveProviderDeviceRuntimes } from '../../provider-device-runtime.ts';
import { IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { createDaemonProviderRuntimeComposition } from '../../provider-device-runtimes.ts';
import { providerCredentialFingerprint } from '../../provider-credential-fingerprint.ts';
import {
  DAEMON_STARTUP_EXIT_CODES,
  tryAcquireDaemonRegistration,
} from '../../daemon-registration-owner.ts';
import { resolveDaemonPaths } from '../../daemon-resolution.ts';
import { interactorResolution } from '../interactor-resolution.ts';

vi.mock('../../platform-runtime.ts', () => ({
  androidObservation: {},
  createRequestPlatformProviders: () => ({
    run: async (_context: unknown, task: () => Promise<unknown>) => await task(),
  }),
  createPlatformRuntimeGateway: () => ({
    applicationLifecycle: {
      recoverStartupResources: async () => {},
      detachForDaemonShutdown: async () => {},
      finalizeDaemonShutdown: async () => {},
    },
    inspectFacts: async () => {
      throw new Error('unused');
    },
    bind: async () => {
      throw new Error('unused');
    },
    shutdown: async () => {},
  }),
  createPlatformDeviceInventoryGateways: () => ({}),
}));

vi.mock('../../provider-device-runtimes.ts', () => ({
  DEFAULT_PROVIDER_RUNTIME_REQUIRED_IDS: [],
  createDaemonProviderRuntimeComposition: vi.fn(async () => ({
    runtimes: [],
    platformModules: [],
  })),
}));

import { startDaemonRuntime } from './daemon-runtime.ts';

afterEach(() => {
  setActiveProviderDeviceRuntimes([]);
  vi.restoreAllMocks();
});

/**
 * The harnesses that boot their own request handler compose the seam themselves, so this is the
 * only check that the process root actually installs it.
 */
test('daemon startup composes the interactor resolution the daemon resolves through', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-interactor-composition-');
  const providerInteractor = { snapshot: async () => ({ nodes: [] }) } as unknown as Interactor;
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

    setActiveProviderDeviceRuntimes([
      {
        provider: 'fixture',
        ownsDevice: () => true,
        getInteractor: () => providerInteractor,
      } as unknown as ProviderDeviceRuntime,
    ]);
    await expect(interactorResolution().resolve(IOS_SIMULATOR, {})).resolves.toBe(
      providerInteractor,
    );

    await runtime?.shutdown();
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('daemon startup compares lease credentials with its own startup environment', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-credential-composition-');
  const daemonEnv = { BROWSERSTACK_USERNAME: 'user', BROWSERSTACK_ACCESS_KEY: 'key-1' };
  const runtime = await startDaemonRuntime({
    env: {
      ...process.env,
      ...daemonEnv,
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
    const { httpPort, token } = JSON.parse(
      fs.readFileSync(resolveDaemonPaths(stateDir).infoPath, 'utf8'),
    ) as { httpPort: number; token: string };
    const allocate = async (env: Record<string, string>) =>
      await (
        await fetch(`http://127.0.0.1:${httpPort}/rpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'agent_device.lease.allocate',
            params: {
              token,
              tenantId: 'tenant',
              runId: 'run',
              leaseProvider: 'browserstack',
              providerCredentialFingerprint: providerCredentialFingerprint('browserstack', env),
            },
          }),
        })
      ).text();

    expect(await allocate({ ...daemonEnv, BROWSERSTACK_ACCESS_KEY: 'key-2' })).toContain(
      'provider-credentials-changed',
    );
    expect(await allocate(daemonEnv)).not.toContain('provider-credentials-changed');
  } finally {
    await runtime?.shutdown();
  }
});

test('a daemon attempt losing the lock shuts down every constructed provider', async () => {
  const stateDir = mkdtempForTestSync('daemon-held-lock-');
  const held = await tryAcquireDaemonRegistration(resolveDaemonPaths(stateDir));
  if (held.status !== 'acquired') throw new Error('registration fixture refused');
  const shutdown = vi.fn(() => {
    throw new Error('cleanup failed');
  });
  const otherShutdown = vi.fn(async () => {});
  vi.mocked(createDaemonProviderRuntimeComposition).mockResolvedValueOnce({
    runtimes: [shutdown, otherShutdown].map(
      (stop, index) =>
        ({
          provider: `fixture-${index}`,
          shutdown: stop,
          leaseLifecycle: {},
        }) as unknown as ProviderDeviceRuntime,
    ),
    platformModules: [],
  });
  const exit = vi.fn();
  const runtime = await startDaemonRuntime({
    env: { AGENT_DEVICE_STATE_DIR: stateDir },
    exit,
    registerProcessHandlers: false,
    stderr: { write: () => {} },
    stdout: { write: () => {} },
  });
  expect(runtime).toBeNull();
  expect(shutdown).toHaveBeenCalledOnce();
  expect(otherShutdown).toHaveBeenCalledOnce();
  expect(exit).toHaveBeenCalledWith(DAEMON_STARTUP_EXIT_CODES.busy);
  await held.owner.finish();
});
