import { afterEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import { AppError } from '@agent-device/kernel/errors';
import { withAppleRunnerProvider } from '@agent-device/platform-apple/runner';
import {
  IOS_SIMULATOR,
  mkdtempForTestSync,
  createTestHostEnvironment,
} from '@agent-device/test-kit';
import { createDaemonRuntimeDeps } from './daemon-composition.ts';
import { createRuntimeStateHandle, runtimeSlot } from '@agent-device/host-kit/runtime-slots';
import { resolveRunnerAppBundleId } from '@agent-device/platform-apple/runner/operations';
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
      detachForDaemonShutdown: async () => [],
      finalizeDaemonShutdown: async () => [],
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

test('each composition binds its own runtime state into the entered handle, not a returned one', async () => {
  const compose = async (name: string) => {
    const baseDir = mkdtempForTestSync(`agent-device-daemon-composition-states-${name}-`);
    const host = createTestHostEnvironment({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: baseDir,
        // The runner's first-choice configuration key: the per-runtime read below must see this
        // runtime's value even when the process env (spread above) carries a different one.
        AGENT_DEVICE_IOS_BUNDLE_ID: `com.test.runtime.${name}`,
      },
    });
    const deps = await createDaemonRuntimeDeps({
      host,
      baseDir,
      sessionsDir: `${baseDir}/sessions`,
      assertShutdownAllowed: undefined,
      resolveSessionDir: (sessionId) => `${baseDir}/sessions/${sessionId}`,
      resolveSessionArtifacts: () => {
        throw new Error('unused');
      },
      openWebSessionNames: () => [],
    });
    return { deps, host };
  };
  const slotKey = Symbol('composition-test');

  // One entered store per runtime (#3794): the daemon enters the handle, then composes into it,
  // so each composition's writes — the Apple runner host, and any slot a platform module declares
  // — land in that runtime's state and nowhere else. The host binding is read back through the
  // runner's own configuration read (`resolveRunnerAppBundleId` takes its env from the bound
  // host), the same path production resource cleanup uses.
  const first = createRuntimeStateHandle();
  const second = createRuntimeStateHandle();
  const firstRun = await first.run(() => compose('first'));
  const secondRun = await second.run(() => compose('second'));
  expect(firstRun.deps).toBeTypeOf('object');
  expect(secondRun.deps).toBeTypeOf('object');

  const inFirst = first.run(() => runtimeSlot(slotKey, () => ({})));
  const inSecond = second.run(() => runtimeSlot(slotKey, () => ({})));
  expect(inFirst).not.toBe(inSecond);
  expect(first.run(() => runtimeSlot(slotKey, () => ({})))).toBe(inFirst);
  expect(first.run(() => resolveRunnerAppBundleId())).toBe('com.test.runtime.first');
  expect(second.run(() => resolveRunnerAppBundleId())).toBe('com.test.runtime.second');
});

test('the composed daemon route configures interactors from its host, not from the process (#3794)', async () => {
  const macOsDevice: DeviceInfo = {
    platform: 'apple',
    appleOs: 'macos',
    id: 'host-mac',
    name: 'Host Mac',
    kind: 'device',
    target: 'desktop',
    booted: true,
  };
  const compose = async (name: string, backend: string) => {
    const baseDir = mkdtempForTestSync(`agent-device-daemon-composition-host-config-${name}-`);
    // The snapshot disagrees with the process on purpose: it is written before the stub below
    // lands in some orders and after in others, so pin the host value explicitly after the spread.
    return await createDaemonRuntimeDeps({
      host: createTestHostEnvironment({
        env: {
          ...process.env,
          AGENT_DEVICE_STATE_DIR: baseDir,
          AGENT_DEVICE_MACOS_APP_BACKEND: backend,
        },
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
  };

  // The process claims the native backend for everyone. The runtime host says otherwise; only an
  // interactor configured from the ambient process would honour the lie.
  vi.stubEnv('AGENT_DEVICE_MACOS_APP_BACKEND', 'native');
  const xctestDeps = await compose('xctest', '');
  const xctestInteractor = await xctestDeps.interactorResolution.resolve(macOsDevice, {});
  const commands: string[] = [];
  await withAppleRunnerProvider(
    async (_device, command) => {
      commands.push(String(command.command));
      return {};
    },
    { deviceId: macOsDevice.id },
    async () => {
      await xctestInteractor.back();
    },
  );
  expect(commands).toEqual(['backInApp']);

  // And the opposite: the process says plain XCTest while this runtime's host opted into the
  // native backend — the daemon route must refuse a runner-only back before dispatching it.
  vi.stubEnv('AGENT_DEVICE_MACOS_APP_BACKEND', '');
  const nativeDeps = await compose('native', 'native');
  const nativeInteractor = await nativeDeps.interactorResolution.resolve(macOsDevice, {});
  await withAppleRunnerProvider(
    async () => {
      throw new Error('the native backend must not dispatch a runner-only back');
    },
    { deviceId: macOsDevice.id },
    async () => {
      await expect(nativeInteractor.back()).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AppError &&
          error.code === 'UNSUPPORTED_OPERATION' &&
          error.details?.reason === 'unsupported-device-backend',
      );
    },
  );
});
