import fs from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import { setActiveProviderDeviceRuntimes } from '../../provider-device-runtime.ts';
import { IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
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
  createDefaultProviderRuntimeComposition: async () => ({ runtimes: [], platformModules: [] }),
}));

import { startDaemonRuntime } from './daemon-runtime.ts';

afterEach(() => {
  setActiveProviderDeviceRuntimes([]);
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
