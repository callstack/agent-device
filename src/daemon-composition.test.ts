import { afterEach, expect, test, vi } from 'vitest';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import {
  IOS_SIMULATOR,
  mkdtempForTestSync,
  createTestHostEnvironment,
} from '@agent-device/test-kit';
import { createDaemonRuntimeDeps } from './daemon-composition.ts';
import { setActiveProviderDeviceRuntimes } from './provider-device-runtime.ts';

const ports = vi.hoisted(() => ({
  inventoryGateways: vi.fn(async (): Promise<object> => ({})),
  shutdownProviders: vi.fn(async () => []),
}));

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
    shutdown: async () => [],
  }),
  createPlatformDeviceInventoryGateways: ports.inventoryGateways,
}));

vi.mock('./provider-device-runtimes.ts', () => ({
  createDaemonProviderRuntimeComposition: async () => ({
    runtimes: [],
    platformModules: [],
    shutdown: ports.shutdownProviders,
    inventory: [],
  }),
}));

afterEach(() => {
  setActiveProviderDeviceRuntimes([]);
  vi.clearAllMocks();
});

test('the composed interactor resolution resolves the interactor of the provider that owns the device', async () => {
  const baseDir = mkdtempForTestSync('agent-device-daemon-composition-interactor-');
  const providerInteractor = { snapshot: async () => ({ nodes: [] }) } as unknown as Interactor;
  const deps = await createDaemonRuntimeDeps({
    host: createTestHostEnvironment({ env: { ...process.env, AGENT_DEVICE_STATE_DIR: baseDir } }),
    baseDir,
    sessionsDir: `${baseDir}/sessions`,
    assertShutdownAllowed: undefined,
    resolveSessionDir: (sessionId) => `${baseDir}/sessions/${sessionId}`,
    resolveSessionArtifacts: () => {
      throw new Error('unused');
    },
    openWebSessionNames: () => [],
  });

  setActiveProviderDeviceRuntimes([
    {
      provider: 'fixture',
      ownsDevice: () => true,
      getInteractor: () => providerInteractor,
    } as unknown as ProviderDeviceRuntime,
  ]);

  await expect(deps.interactorResolution.resolve(IOS_SIMULATOR, {})).resolves.toBe(
    providerInteractor,
  );
});

test('a composition step that fails after the plugins were set up closes them once and hands nothing over', async () => {
  const baseDir = mkdtempForTestSync('agent-device-daemon-composition-rollback-');
  ports.inventoryGateways.mockRejectedValueOnce(new Error('inventory gateways failed'));

  await expect(
    createDaemonRuntimeDeps({
      host: createTestHostEnvironment({
        env: { ...process.env, AGENT_DEVICE_STATE_DIR: baseDir },
      }),
      baseDir,
      sessionsDir: `${baseDir}/sessions`,
      assertShutdownAllowed: undefined,
      resolveSessionDir: (sessionId) => `${baseDir}/sessions/${sessionId}`,
      resolveSessionArtifacts: () => {
        throw new Error('unused');
      },
      openWebSessionNames: () => [],
    }),
  ).rejects.toThrow('inventory gateways failed');

  expect(ports.shutdownProviders).toHaveBeenCalledOnce();
});

test('a composition that succeeds leaves the plugins open for the daemon to close', async () => {
  const baseDir = mkdtempForTestSync('agent-device-daemon-composition-owned-');
  const deps = await createDaemonRuntimeDeps({
    host: createTestHostEnvironment({
      env: { ...process.env, AGENT_DEVICE_STATE_DIR: baseDir },
    }),
    baseDir,
    sessionsDir: `${baseDir}/sessions`,
    assertShutdownAllowed: undefined,
    resolveSessionDir: (sessionId) => `${baseDir}/sessions/${sessionId}`,
    resolveSessionArtifacts: () => {
      throw new Error('unused');
    },
    openWebSessionNames: () => [],
  });

  expect(ports.shutdownProviders).not.toHaveBeenCalled();
  await deps.shutdownProviderRuntimes();
  expect(ports.shutdownProviders).toHaveBeenCalledOnce();
});
