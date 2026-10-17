import fs from 'node:fs';
import { expect, test, vi } from 'vitest';
import { startDaemonRuntime } from '@agent-device/daemon';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { createDaemonRuntimeDeps } from './daemon-composition.ts';
import { providerCredentialFingerprint } from './provider-credential-fingerprint.ts';

vi.mock('./platform-runtime.ts', () => ({
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

vi.mock('./provider-device-runtimes.ts', () => ({
  DEFAULT_PROVIDER_RUNTIME_REQUIRED_IDS: [],
  createDaemonProviderRuntimeComposition: async () => ({
    runtimes: [
      {
        provider: 'browserstack',
        leaseLifecycle: {},
        deviceInventoryProvider: { discover: async () => [] },
        ownsDevice: () => false,
        getInteractor: () => undefined,
        shutdown: async () => {},
      },
    ],
    platformModules: [],
  }),
}));

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
    composeDeps: createDaemonRuntimeDeps,
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
    const accepted = await allocate(daemonEnv);
    expect(accepted).not.toContain('provider-credentials-changed');
    expect(accepted).toContain('leaseId');
  } finally {
    await runtime?.shutdown();
  }
});
