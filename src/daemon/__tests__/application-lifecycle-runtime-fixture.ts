import { vi } from 'vitest';
import {
  bindDirectApplicationLifecycle,
  bindLocalApplicationLifecycleInteractor,
} from '@agent-device/contracts/application-lifecycle-interaction';
import type {
  ApplicationLifecycleExecution,
  ApplicationLifecycleRuntimeOperations,
  RuntimeHintsApplicationInput,
} from '@agent-device/contracts/application-lifecycle-runtime';
import { fixtureResolveSessionAppBundleIdForTarget } from './platform-services-fixture.ts';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import { isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import type { TargetShutdownResult } from '@agent-device/contracts/device';

type LifecycleEffectContext = ApplicationLifecycleExecution &
  Readonly<{
    appBundleId?: string;
    signal: AbortSignal;
    terminateRunningApp?: boolean;
  }>;

/**
 * A platform-neutral readiness pause point. Package-owned readiness runs inside the admitted
 * binding, so a router-level test that needs to hold an open mid-readiness awaits this instead of
 * a per-platform host call.
 */
export const awaitFixtureReadiness = vi.fn(async (_device: DeviceInfo): Promise<void> => undefined);

/**
 * Readiness discovery, as a seam. It reports the device under test as an already-running emulator
 * so lifecycle fixtures never launch or poll a boot; a test that needs a pre-effect readiness
 * failure rejects this instead.
 */
export const discoverReadyAndroidEmulators = vi.fn(async (readyDevice: DeviceInfo) => [
  {
    ...readyDevice,
    id: readyDevice.id.startsWith('emulator-') ? readyDevice.id : `emulator-${readyDevice.id}`,
    booted: true,
  },
]);

/**
 * Handler tests observe an admitted lifecycle open/close through this spy: package lifecycle
 * suites own dispatch mechanics, while handler tests assert facts admission, binding, session
 * policy, and error precedence around this call.
 */
export const dispatchApplicationLifecycleEffect = vi.fn(
  async (
    _device: DeviceInfo,
    _command: 'open' | 'close',
    _positionals: string[],
    _outPath: string | undefined,
    _context: LifecycleEffectContext,
  ): Promise<void> => undefined,
);

/** The runtime-hint asks as the fixture answers them, at the port, with the bound device. */
export const applyRuntimeHintsFixture = vi.fn(
  async (_input: RuntimeHintsApplicationInput & Readonly<{ device: DeviceInfo }>) => undefined,
);
export const clearRuntimeHintsFixture = vi.fn(
  async (_input: RuntimeHintsApplicationInput & Readonly<{ device: DeviceInfo }>) => undefined,
);

/** The fixture's canned `prepareAppleRunner` answer, spied at the port. */
const prepareAppleRunnerFixture = vi.fn(
  async (): Promise<{
    runner: Record<string, unknown>;
    connectMs: number;
    healthCheckMs: number;
  }> => ({ runner: { currentUptimeMs: 42 }, connectMs: 3, healthCheckMs: 3 }),
);

/**
 * The `ApplicationLifecycleRuntimeOperations` port as the daemon suites need it: the contract's
 * canonical direct lifecycle over the fixture interactor's spies, with readiness, runtime hints,
 * and runner preparation answered by port spies. The real apple/android sequencing (boot, runner
 * prewarm policy, relaunch identity, post-open observation) belongs to the platform packages and
 * is pinned under `src/__tests__/daemon-composition/`.
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
  const direct = bindDirectApplicationLifecycle({
    owner: 'lifecycle-fixture',
    openTargetIdentity: 'bundle-id',
    // The fixture owner's canned open does not replace a running application, so relaunch closes
    // first — the contract's own knob, not a per-platform copy of the real owners' choices.
    closeBeforeRelaunch: true,
    binding: bindLocalApplicationLifecycleInteractor({
      device,
      signal,
      resolveInteractor: async (target, runner) =>
        applicationLifecycleFixtureInteractor(target, runner),
    }),
  });
  const directOpenApplication = direct.openApplication;
  return Object.freeze({
    ...direct,
    resolveOpenTarget: async (input) => {
      if (
        isMacOs(device) &&
        input.surface !== undefined &&
        input.surface !== 'app' &&
        input.surface !== 'desktop' &&
        input.surface !== 'menubar'
      ) {
        // Frontmost surfaces resolve through the macos package leaf the suites already mock.
        const { resolveFrontmostMacOsApp } = await import('@agent-device/platform-apple/macos');
        const frontmost = await resolveFrontmostMacOsApp();
        return Object.freeze({
          ...(frontmost.bundleId === undefined ? {} : { appBundleId: frontmost.bundleId }),
          ...(input.target === undefined
            ? frontmost.appName === undefined
              ? {}
              : { appName: frontmost.appName }
            : { appName: input.target }),
        });
      }
      const appBundleId = await fixtureResolveSessionAppBundleIdForTarget(
        device,
        input.target,
        input.currentAppBundleId,
      );
      return Object.freeze({
        ...(appBundleId === undefined ? {} : { appBundleId }),
        ...(input.target === undefined ? {} : { appName: input.target }),
      });
    },
    prepareApplicationOpen: async (_input) => {
      await awaitFixtureReadiness(device);
      if (device.platform === 'android' && device.booted !== true) {
        await discoverReadyAndroidEmulators(device);
      }
    },
    openApplication: async (input) => {
      if (input.applyRuntimeHints) {
        await input.applyRuntimeHints({ appId: input.appBundleId, values: input.runtimeHints });
      }
      return await directOpenApplication(input);
    },
    applyRuntimeHints: async (input) => {
      await applyRuntimeHintsFixture({ device, ...input });
    },
    clearRuntimeHints: async (input) => {
      await clearRuntimeHintsFixture({ device, ...input });
    },
    finalizeApplicationClose: async (input) =>
      input.shutdownTarget ? { shutdown: await shutdownTarget(device) } : {},
    prepareAppleRunner: async () => await prepareAppleRunnerFixture(),
  });
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
