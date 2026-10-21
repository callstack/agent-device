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
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
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
 * a per-platform host call. A daemon-lane test that needs a readiness FAILURE rejects
 * `prepareApplicationOpenFixture` (the port's prepare step), which is where the canned answer
 * surfaces to the open flow.
 */
export const awaitFixtureReadiness = vi.fn(async (_device: DeviceInfo): Promise<void> => undefined);

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

/**
 * Loads the lifecycle operations a test binding builds: the daemon default is the canned port
 * fixture, and root composition lanes pass their real composed fixture. The gateway factories and
 * the session-command harness both take it as a parameter; nothing installs it into a module global.
 */
export type LifecycleOperationsLoader = (
  device: DeviceInfo,
  signal?: AbortSignal,
  shutdownTarget?: (device: DeviceInfo) => Promise<TargetShutdownResult>,
) => Promise<ApplicationLifecycleRuntimeOperations>;

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
 * The canned `resolveOpenTarget` answer: the contract's canonical direct-lifecycle resolution for
 * the fixture owner (a dotted, non-deep-link target is the bundle id; otherwise the session's
 * current one), reached through the `directResolve` the fixture passes in. No open-target, surface,
 * or platform rule lives here — the real owners' resolution rules (apple/android target identity,
 * macOS frontmost surfaces, Safari and deep-link fallbacks) are pinned beside the root modules
 * (`src/platform-runtime-open-target.test.ts`, `src/platform-runtime-apple-application-tools.test.ts`).
 * A daemon suite that needs a different bundle id answers per case through this spy.
 */
export const resolveOpenTargetFixture = vi.fn(
  async (
    _device: DeviceInfo,
    directResolve: NonNullable<ApplicationLifecycleRuntimeOperations['resolveOpenTarget']>,
    input: Parameters<NonNullable<ApplicationLifecycleRuntimeOperations['resolveOpenTarget']>>[0],
  ) => await directResolve(input),
);

/**
 * The canned `prepareApplicationOpen` answer: pause at the fixture's readiness seam and succeed.
 * The per-platform readiness sequencing (android discovery for a stopped AVD, simulator cold boot)
 * is the composed owners' rule, pinned under `src/__tests__/daemon-composition/`.
 */
export const prepareApplicationOpenFixture = vi.fn(async (device: DeviceInfo): Promise<void> => {
  await awaitFixtureReadiness(device);
});

/**
 * The canned `openApplication` answer: run the contract's canonical direct lifecycle (the `direct`
 * operations the fixture passes in) with the fact-admitted runtime hints applied at the port when
 * the open requests them. A hinted relaunch closes first, then applies the hints, then opens —
 * the same order the apple/android owners sequence, so daemon suites cannot encode a reversed
 * lifecycle. Relaunch identity, runner prewarm policy, and post-open observation are the composed
 * owners' rules, pinned under `src/__tests__/daemon-composition/`.
 */
const openApplicationFixture = vi.fn(
  async (
    _device: DeviceInfo,
    direct: ApplicationLifecycleRuntimeOperations,
    input: Parameters<ApplicationLifecycleRuntimeOperations['openApplication']>[0],
  ) => {
    if (input.applyRuntimeHints) {
      // The direct owner's close-before-relaunch happens inside its open; a hinted relaunch
      // must close before the hints land, so take the close here and open as a fresh launch.
      if (input.relaunch && input.target !== undefined) {
        await direct.closeApplication({
          positionals: [input.appBundleId ?? input.target],
          surface: input.surface,
          execution: input.execution,
        });
        await input.applyRuntimeHints({ appId: input.appBundleId, values: input.runtimeHints });
        return await direct.openApplication({ ...input, relaunch: false });
      }
      await input.applyRuntimeHints({ appId: input.appBundleId, values: input.runtimeHints });
    }
    return await direct.openApplication(input);
  },
);

/**
 * The `ApplicationLifecycleRuntimeOperations` port as the daemon suites need it: the contract's
 * canonical direct lifecycle over the fixture interactor's spies, with open-target resolution,
 * readiness, open sequencing, runtime hints, and runner preparation answered by port spies whose
 * canned answers carry no platform rule. The real apple/android sequencing (boot, runner prewarm
 * policy, relaunch identity, post-open observation) belongs to the platform packages and is pinned
 * under `src/__tests__/daemon-composition/`.
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
  const directResolveOpenTarget = direct.resolveOpenTarget;
  return Object.freeze({
    ...direct,
    resolveOpenTarget: async (input) =>
      await resolveOpenTargetFixture(device, directResolveOpenTarget, input),
    prepareApplicationOpen: async () => {
      await prepareApplicationOpenFixture(device);
    },
    openApplication: async (input) => await openApplicationFixture(device, direct, input),
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
