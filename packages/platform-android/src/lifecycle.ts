import {
  type ApplicationLifecycleRuntimeOperations,
  type OpenApplicationInput,
  type OpenApplicationOutcome,
  hasRuntimeTransportHintValues,
} from '@agent-device/contracts/application-lifecycle-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import {
  bindLocalApplicationLifecycleInteractor,
  followUpRuntimeLaunchUrl,
  invokeApplicationClose,
  invokeApplicationOpen,
} from '@agent-device/contracts/application-lifecycle-interaction';
import { ensureAndroidReady } from './readiness/runtime.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

/** The Android package receives only the ports its lifecycle binding consumes. */
type AndroidLifecycleHost = Pick<
  PlatformRuntimeHost,
  | 'androidApplications'
  | 'clock'
  | 'commands'
  | 'deviceReadiness'
  | 'deviceShutdown'
  | 'localInteractors'
  | 'toolchains'
>;

type MutableOpenTiming = {
  -readonly [Key in keyof OpenApplicationOutcome['timing']]: OpenApplicationOutcome['timing'][Key];
};

type AndroidLifecycleParams = Readonly<{
  host: AndroidLifecycleHost;
  device: DeviceInfo;
  signal: AbortSignal;
}>;

/** Android owns lifecycle sequencing, including local adb-backed hints and durable test-IME state. */
export function bindAndroidApplicationLifecycle(
  params: AndroidLifecycleParams,
): ApplicationLifecycleRuntimeOperations {
  const { host, device, signal } = params;
  const binding = bindLocalApplicationLifecycleInteractor({
    device,
    signal,
    resolveInteractor: host.localInteractors.resolve,
  });
  return Object.freeze({
    resolveOpenTarget: async (input) =>
      await host.androidApplications.resolveOpenTarget(device, input),
    prepareApplicationOpen: async (input) => {
      await ensureAndroidReady(host, device, { headless: false }, signal);
      void input;
    },
    openApplication: async (input) => await openAndroidApplication(host, binding, input),
    applyRuntimeHints: async (input) =>
      await host.androidApplications.applyRuntimeHints(device, input),
    clearRuntimeHints: async (input) =>
      await host.androidApplications.clearRuntimeHints(device, input),
    closeApplication: async (input) => {
      if (input.ensureReady) {
        await ensureAndroidReady(host, device, { headless: false }, signal);
      }
      await invokeApplicationClose({
        device,
        interactor: await binding.resolveInteractor(input.execution, input.appBundleId),
        positionals: input.positionals,
      });
    },
    finalizeApplicationClose: async (input) => {
      await host.androidApplications.restoreTestIme(device, {
        stateDir: input.stateDir,
      });
      const shutdown =
        input.shutdownTarget && device.kind === 'emulator'
          ? await host.deviceShutdown.android.shutdownTarget(device, signal)
          : undefined;
      return shutdown === undefined ? {} : { shutdown };
    },
    prepareAppleRunner: unavailable,
    configureProviderPortReverse: unavailable,
  });
}

async function openAndroidApplication(
  host: AndroidLifecycleHost,
  binding: ReturnType<typeof bindLocalApplicationLifecycleInteractor>,
  input: OpenApplicationInput,
): Promise<OpenApplicationOutcome> {
  const timing: MutableOpenTiming = {};
  if (input.relaunch && input.target) {
    const closeStartedAtMs = Date.now();
    await invokeApplicationClose({
      device: binding.device,
      interactor: await binding.resolveInteractor(input.execution, input.appBundleId),
      positionals: [input.appBundleId ?? input.target],
    });
    timing.relaunchCloseDurationMs = elapsed(closeStartedAtMs);
  }
  if (hasRuntimeTransportHintValues(input.runtimeHints)) {
    if (!input.applyRuntimeHints) {
      throw new AppError(
        'COMMAND_FAILED',
        'Runtime hint operation was not admitted for this open.',
        {
          reason: 'runtime-hints-operation-missing',
        },
      );
    }
    const hintsStartedAtMs = Date.now();
    await input.applyRuntimeHints({ appId: input.appBundleId, values: input.runtimeHints });
    timing.runtimeHintsDurationMs = elapsed(hintsStartedAtMs);
  }
  const openStartedAtMs = Date.now();
  await invokeApplicationOpen({
    device: binding.device,
    interactor: await binding.resolveInteractor(input.execution, input.appBundleId),
    positionals: input.positionals,
    appBundleId: input.appBundleId,
    execution: input.execution,
  });
  timing.openDispatchDurationMs = elapsed(openStartedAtMs);
  if (input.enableTestIme) {
    // Only a failed durable-record fence rejects here; the tool reports an unobtainable helper as
    // a warning so the open falls back to the ordinary text-entry path.
    await host.androidApplications.activateTestIme(binding.device, {
      stateDir: input.stateDir,
    });
  }
  const runtimeLaunchUrl = followUpRuntimeLaunchUrl(input);
  if (runtimeLaunchUrl) {
    const launchUrlStartedAtMs = Date.now();
    await invokeApplicationOpen({
      device: binding.device,
      interactor: await binding.resolveInteractor(
        {
          ...input.execution,
          clearAppState: undefined,
          launchConsole: undefined,
          launchArgs: undefined,
        },
        input.appBundleId,
      ),
      positionals: [runtimeLaunchUrl],
      appBundleId: input.appBundleId,
      execution: {
        ...input.execution,
        clearAppState: undefined,
        launchConsole: undefined,
        launchArgs: undefined,
      },
    });
    timing.launchUrlDurationMs = elapsed(launchUrlStartedAtMs);
  } else {
    timing.launchUrlDurationMs = 0;
  }
  const appBundleId = await host.androidApplications.inferOpenedAppBundleId(
    binding.device,
    input.target,
    input.appBundleId,
  );
  if (appBundleId) {
    await host.androidApplications.resetFramePerfStats(binding.device, appBundleId);
  }
  timing.postOpenSettleDurationMs = 0;
  return { appBundleId, timing };
}

function elapsed(startedAtMs: number): number {
  return Math.max(0, Date.now() - startedAtMs);
}

async function unavailable(): Promise<never> {
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    'This lifecycle operation is unavailable for Android.',
  );
}
