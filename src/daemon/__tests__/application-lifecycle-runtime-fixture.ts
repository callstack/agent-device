import type {
  ApplicationLifecycleExecution,
  ApplicationLifecycleRuntimeOperations,
  DeviceBinding,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
} from '@agent-device/contracts/platform';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interaction';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { TargetShutdownResult } from '@agent-device/contracts/device';
import { vi } from 'vitest';
import { createAndroidApplicationTools } from '../../platform-runtime-android-application-tools.ts';
import { createAppleApplicationTools } from '../../platform-runtime-apple-application-tools.ts';
import { createComposedPlatformRuntimeGateway } from '../../platform-runtime-gateway.ts';
import { platformRuntimeModules } from '../../platform-runtime.ts';

type LifecycleEffectContext = ApplicationLifecycleExecution &
  Readonly<{
    appBundleId?: string;
    signal: AbortSignal;
    terminateRunningApp?: boolean;
  }>;

/**
 * Handler tests observe an admitted lifecycle effect through this test-only seam. It is not a
 * wrapper around the retired command dispatcher: package lifecycle tests own dispatch mechanics,
 * while handler tests assert facts admission, binding, session policy, and error precedence.
 */
/**
 * Readiness discovery, as a seam. It reports the device under test as an already-running emulator
 * so lifecycle fixtures never launch or poll a boot; a test that needs a pre-effect readiness
 * failure rejects this instead.
 */
/**
 * A platform-neutral readiness pause point. Package-owned readiness runs inside the admitted
 * binding, so a router-level test that needs to hold an open mid-readiness awaits this instead of
 * a per-platform host call.
 */
export const awaitFixtureReadiness = vi.fn(async (_device: DeviceInfo): Promise<void> => undefined);

export const discoverReadyAndroidEmulators = vi.fn(async (readyDevice: DeviceInfo) => [
  {
    ...readyDevice,
    id: readyDevice.id.startsWith('emulator-') ? readyDevice.id : `emulator-${readyDevice.id}`,
    booted: true,
  },
]);

export const dispatchApplicationLifecycleEffect = vi.fn(
  async (
    _device: DeviceInfo,
    _command: 'open' | 'close',
    _positionals: string[],
    _outPath: string | undefined,
    _context: LifecycleEffectContext,
  ): Promise<void> => undefined,
);

/**
 * Handler fixtures enter each package through its public runtime module. The only test double is
 * the final interactor effect, so handler tests exercise package-owned lifecycle sequencing
 * without reaching into a package implementation or recreating a root lifecycle dispatcher.
 */
export async function applicationLifecycleRuntimeFixture(
  device: DeviceInfo,
  signal: AbortSignal = new AbortController().signal,
  shutdownTarget: (device: DeviceInfo) => Promise<TargetShutdownResult> = async () => ({
    success: true,
    exitCode: 0,
    stdout: '',
    stderr: '',
  }),
): Promise<ApplicationLifecycleRuntimeOperations> {
  const gateway = createComposedPlatformRuntimeGateway({
    modules: platformRuntimeModules,
    loadHost: async () => fixtureHost(device, shutdownTarget),
  });
  const binding = await gateway.bind({
    device,
    intent: { kind: 'ordinary' },
    scope: { signal, diagnostics: { emit: () => {} }, progress: { report: () => {} } },
  });
  return lifecycleOperations(binding);
}

function lifecycleOperations(
  binding: DeviceBinding<PlatformRuntimeOperations>,
): ApplicationLifecycleRuntimeOperations {
  const operations = binding.operations;
  const keys = [
    'resolveOpenTarget',
    'prepareApplicationOpen',
    'openApplication',
    'applyRuntimeHints',
    'clearRuntimeHints',
    'closeApplication',
    'finalizeApplicationClose',
    'prepareAppleRunner',
    'configureProviderPortReverse',
  ] as const satisfies readonly (keyof ApplicationLifecycleRuntimeOperations)[];
  const selected = Object.fromEntries(
    keys.flatMap((key) => {
      const operation = operations[key];
      return operation ? [[key, operation]] : [];
    }),
  );
  return Object.freeze(selected) as ApplicationLifecycleRuntimeOperations;
}

function fixtureHost(
  readyDevice: DeviceInfo,
  shutdownTarget: (device: DeviceInfo) => Promise<TargetShutdownResult>,
): PlatformRuntimeHost {
  let simulatorState = readyDevice.booted === false ? 'Shutdown' : 'Booted';
  const localInteractors = Object.freeze({
    resolve: async (device: DeviceInfo, runner: RunnerContext): Promise<Interactor> =>
      applicationLifecycleFixtureInteractor(device, runner),
  });
  return {
    localInteractors,
    appleApplications: createAppleApplicationTools(),
    androidApplications: createAndroidApplicationTools(),
    deviceShutdown: Object.freeze({
      apple: Object.freeze({
        shutdownTarget: async (device: DeviceInfo) => await shutdownTarget(device),
      }),
      android: Object.freeze({
        shutdownTarget: async (device: DeviceInfo) => await shutdownTarget(device),
      }),
      close: Object.freeze({
        canShutdownTarget: async (device: DeviceInfo) =>
          (device.platform === 'apple' && device.kind === 'simulator') ||
          (device.platform === 'android' && device.kind === 'emulator'),
        shutdownTarget: async (device: DeviceInfo) => await shutdownTarget(device),
      }),
    }),
    // Readiness is package-owned; these handler fixtures exercise lifecycle dispatch, so the
    // narrow ports report an already-ready device instead of booting anything.
    deviceReadiness: Object.freeze({
      applePhysical: Object.freeze({
        ensureConnected: async (_device: DeviceInfo, signal: AbortSignal) => {
          signal.throwIfAborted();
        },
      }),
      appleAutomation: Object.freeze({
        keepHot: () => undefined,
        markBooted: () => {},
        wasRecentlyObservedBooted: async () => false,
      }),
      androidEmulator: Object.freeze({
        discover: async (_request: unknown, signal: AbortSignal) => {
          signal.throwIfAborted();
          await awaitFixtureReadiness(readyDevice);
          return await discoverReadyAndroidEmulators(readyDevice);
        },
        launch: () => 1,
        terminate: async () => undefined,
      }),
    }),
    // Readiness reads the device's own boot state, so a `booted: false` fixture still exercises
    // the cold-boot path (and its runner-cache prewarm hook) before settling.
    appleTools: Object.freeze({
      isXcrunAvailable: async () => true,
      run: async (request: Readonly<{ args: readonly string[] }>) => {
        await awaitFixtureReadiness(readyDevice);
        if (request.args.includes('boot')) {
          simulatorState = 'Booted';
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return {
          stdout: JSON.stringify({
            devices: { fixture: [{ udid: readyDevice.id, state: simulatorState }] },
          }),
          stderr: '',
          exitCode: 0,
        };
      },
    }),
    commands: Object.freeze({
      which: async (executable: string) => executable,
      run: async () => ({ stdout: '1', stderr: '', exitCode: 0 }),
    }),
    toolchains: Object.freeze({ prepare: async () => undefined }),
    clock: Object.freeze({
      now: () => Date.now(),
      sleep: async () => undefined,
    }),
    processTransports: Object.freeze({
      resolve: async () => ({ mode: 'local' as const }),
    }),
    networkTransports: Object.freeze({
      resolve: async () => ({ mode: 'local' as const }),
    }),
    screenRecording: Object.freeze({
      apple: Object.freeze({
        availability: async () => ({
          available: false as const,
          hint: 'Screen recording is outside this lifecycle fixture.',
        }),
      }),
      android: Object.freeze({ resolve: async () => ({}) }),
      web: Object.freeze({ resolve: async () => undefined }),
    }),
  } as unknown as PlatformRuntimeHost;
}

export function applicationLifecycleFixtureInteractor(
  device: DeviceInfo,
  runner: RunnerContext,
): Interactor {
  let clearAppState = false;
  return {
    open: async (app, options) => {
      await dispatchApplicationLifecycleEffect(
        device,
        'open',
        options?.url === undefined ? [app] : [app, options.url],
        undefined,
        lifecycleEffectContext(runner, {
          appBundleId: options?.appBundleId,
          activity: options?.activity,
          clearAppState,
          launchArgs: options?.launchArgs,
          launchConsole: options?.launchConsole,
          terminateRunningApp: options?.terminateRunningApp,
        }),
      );
      clearAppState = false;
    },
    openDevice: async () => {
      await dispatchApplicationLifecycleEffect(
        device,
        'open',
        [],
        undefined,
        lifecycleEffectContext(runner, { clearAppState }),
      );
      clearAppState = false;
    },
    close: async (app) =>
      await dispatchApplicationLifecycleEffect(
        device,
        'close',
        app ? [app] : [],
        undefined,
        lifecycleEffectContext(runner, {}),
      ),
    setSetting: async (setting, action) => {
      if (setting === 'clear-app-state' && action === 'clear') clearAppState = true;
    },
  } as Interactor;
}

function lifecycleEffectContext(
  runner: RunnerContext,
  input: Readonly<{
    appBundleId?: string;
    activity?: string;
    clearAppState?: boolean;
    launchArgs?: readonly string[];
    launchConsole?: string;
    terminateRunningApp?: boolean;
  }>,
): LifecycleEffectContext {
  return {
    requestId: runner.requestId,
    logPath: runner.logPath,
    traceLogPath: runner.traceLogPath,
    verbose: runner.verbose,
    activity: input.activity,
    clearAppState: input.clearAppState,
    launchArgs: input.launchArgs,
    launchConsole: input.launchConsole,
    iosXctestrunFile: runner.iosXctestrunFile,
    iosXctestDerivedDataPath: runner.iosXctestDerivedDataPath,
    iosXctestEnvDir: runner.iosXctestEnvDir,
    runnerLeaseContext: runner.runnerLeaseContext,
    appBundleId: input.appBundleId ?? runner.appBundleId,
    signal: runner.signal ?? new AbortController().signal,
    ...(input.terminateRunningApp === undefined
      ? {}
      : { terminateRunningApp: input.terminateRunningApp }),
  };
}
