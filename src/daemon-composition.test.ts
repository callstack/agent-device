import { afterEach, expect, test, vi } from 'vitest';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import { IOS_SIMULATOR, mkdtempForTestSync } from '@agent-device/test-kit';
import { createDaemonRuntimeDeps } from './daemon-composition.ts';
import { setActiveProviderDeviceRuntimes } from './provider-device-runtime.ts';

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
  createDaemonProviderRuntimeComposition: async () => ({ runtimes: [], platformModules: [] }),
}));

afterEach(() => {
  setActiveProviderDeviceRuntimes([]);
});

test('the composed interactor resolution resolves the interactor of the provider that owns the device', async () => {
  const baseDir = mkdtempForTestSync('agent-device-daemon-composition-interactor-');
  const providerInteractor = { snapshot: async () => ({ nodes: [] }) } as unknown as Interactor;
  const deps = await createDaemonRuntimeDeps({
    env: { ...process.env, AGENT_DEVICE_STATE_DIR: baseDir },
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
