import { isDeepLinkTarget } from './open-target.ts';
import {
  LAUNCH_CONSOLE_DIRECT_APP_ONLY_MESSAGE,
  LAUNCH_CONSOLE_IOS_SIMULATOR_ONLY_MESSAGE,
} from './launch-console.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { isIosFamily } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { Interactor, RunnerContext } from './interactor-types.ts';
import type {
  ApplicationLifecycleExecution,
  ApplicationLifecycleProviderInteractorResolver,
  ApplicationLifecycleRuntimeOperations,
  OpenApplicationInput,
  OpenApplicationOutcome,
  OpenTargetResolution,
  OpenTargetResolutionInput,
} from './application-lifecycle-runtime.ts';

/**
 * The exact request-bound interactor authority for a lifecycle operation.  It is deliberately
 * smaller than a platform runtime: platform packages own target, runner, hint, and durable-state
 * mechanics; this port only turns an already-selected owner into an interactor without consulting
 * ambient provider request state.
 */
export type ApplicationLifecycleInteractorBinding = Readonly<{
  device: DeviceInfo;
  signal: AbortSignal;
  resolveInteractor(
    execution: ApplicationLifecycleExecution,
    appBundleId?: string,
  ): Promise<Interactor>;
}>;

export type LocalApplicationLifecycleInteractorResolver = (
  device: DeviceInfo,
  runner: RunnerContext,
) => Promise<Interactor>;

/** Builds the stable runner context shared by direct package lifecycle operations. */
function applicationLifecycleRunnerContext(
  execution: ApplicationLifecycleExecution,
  appBundleId: string | undefined,
  signal: AbortSignal,
): RunnerContext {
  return {
    requestId: execution.requestId,
    signal,
    appBundleId,
    verbose: execution.verbose,
    logPath: execution.logPath,
    traceLogPath: execution.traceLogPath,
    iosXctestrunFile: execution.iosXctestrunFile,
    iosXctestDerivedDataPath: execution.iosXctestDerivedDataPath,
    iosXctestEnvDir: execution.iosXctestEnvDir,
    runnerLeaseContext: execution.runnerLeaseContext,
  };
}

type ApplicationLifecycleInteractorBindingParams =
  | Readonly<{
      device: DeviceInfo;
      signal: AbortSignal;
      resolveLocalInteractor: LocalApplicationLifecycleInteractorResolver;
      ownership: 'local';
    }>
  | Readonly<{
      device: DeviceInfo;
      signal: AbortSignal;
      ownership: Readonly<{
        kind: 'provider';
        resolveInteractor: ApplicationLifecycleProviderInteractorResolver;
      }>;
    }>;

/**
 * Captures selected-owner interactor authority at bind time. A provider resolver that no longer
 * has a live session fails closed; it never falls through to local adb, simctl, or runner code.
 */
function bindApplicationLifecycleInteractor(
  params: ApplicationLifecycleInteractorBindingParams,
): ApplicationLifecycleInteractorBinding {
  const { device, signal, ownership } = params;
  return Object.freeze({
    device,
    signal,
    resolveInteractor: async (execution, appBundleId) => {
      const runner = applicationLifecycleRunnerContext(execution, appBundleId, signal);
      if (ownership === 'local') return await params.resolveLocalInteractor(device, runner);
      const interactor = ownership.resolveInteractor(runner);
      if (interactor) return interactor;
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'Provider-owned application lifecycle operation has no bound provider interactor.',
        { reason: 'provider-runtime-interactor-missing', deviceId: device.id },
      );
    },
  });
}

/** Local packages receive only the selected local interactor construction port. */
export function bindLocalApplicationLifecycleInteractor(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: LocalApplicationLifecycleInteractorResolver;
  }>,
): ApplicationLifecycleInteractorBinding {
  return bindApplicationLifecycleInteractor({
    device: params.device,
    signal: params.signal,
    resolveLocalInteractor: params.resolveInteractor,
    ownership: 'local',
  });
}

/** Provider packages never receive a local interactor path for their selected lifecycle owner. */
export function bindProviderApplicationLifecycleInteractor(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: ApplicationLifecycleProviderInteractorResolver;
  }>,
): ApplicationLifecycleInteractorBinding {
  return bindApplicationLifecycleInteractor({
    device: params.device,
    signal: params.signal,
    ownership: { kind: 'provider', resolveInteractor: params.resolveInteractor },
  });
}

/**
 * Canonical direct open semantics used only after a package lifecycle binding has admitted the
 * operation. It intentionally has no device-resolution or platform-mechanics branches.
 */
export async function invokeApplicationOpen(
  params: Readonly<{
    device: DeviceInfo;
    interactor: Interactor;
    positionals: readonly string[];
    appBundleId?: string;
    execution: ApplicationLifecycleExecution;
    terminateRunningApp?: boolean;
  }>,
): Promise<void> {
  const { device, positionals, execution } = params;
  assertOpenPositionals(positionals);
  const app = positionals[0];
  const url = positionals[1];
  if (!app) {
    await invokeDeviceOpen(params);
    return;
  }
  assertOpenDeviceSupport(device, execution);
  if (url !== undefined) {
    await invokeApplicationUrlOpen(params, app, url);
    return;
  }
  await invokeApplicationTargetOpen(params, app);
}

type DirectOpenParameters = Readonly<{
  device: DeviceInfo;
  interactor: Interactor;
  positionals: readonly string[];
  appBundleId?: string;
  execution: ApplicationLifecycleExecution;
  terminateRunningApp?: boolean;
}>;

function assertOpenPositionals(positionals: readonly string[]): void {
  if (positionals.length > 2) {
    throw new AppError('INVALID_ARGS', 'open accepts at most two arguments: <app|url> [url]');
  }
}

async function invokeDeviceOpen(params: DirectOpenParameters): Promise<void> {
  if (params.execution.launchConsole) {
    throw new AppError('INVALID_ARGS', '--launch-console requires an app target');
  }
  if (params.execution.launchArgs && params.execution.launchArgs.length > 0) {
    throw new AppError('INVALID_ARGS', '--launch-args requires an app target');
  }
  await params.interactor.openDevice();
}

function assertOpenDeviceSupport(
  device: DeviceInfo,
  execution: ApplicationLifecycleExecution,
): void {
  if (execution.launchConsole && (!isIosFamily(device) || device.kind !== 'simulator')) {
    throw new AppError('UNSUPPORTED_OPERATION', LAUNCH_CONSOLE_IOS_SIMULATOR_ONLY_MESSAGE);
  }
  if (device.platform === 'linux' && execution.launchArgs && execution.launchArgs.length > 0) {
    throw new AppError('UNSUPPORTED_OPERATION', '--launch-args is not supported on Linux.');
  }
}

async function invokeApplicationUrlOpen(
  params: DirectOpenParameters,
  app: string,
  url: string,
): Promise<void> {
  if (isDeepLinkTarget(app)) {
    throw new AppError(
      'INVALID_ARGS',
      'open <app> <url> requires an app target as the first argument',
    );
  }
  if (!isDeepLinkTarget(url)) {
    throw new AppError('INVALID_ARGS', 'open <app> <url> requires a valid URL target');
  }
  if (params.execution.launchConsole) {
    throw new AppError('INVALID_ARGS', LAUNCH_CONSOLE_DIRECT_APP_ONLY_MESSAGE);
  }
  await params.interactor.open(app, {
    activity: params.execution.activity,
    appBundleId: params.appBundleId,
    launchArgs: params.execution.launchArgs ? [...params.execution.launchArgs] : undefined,
    terminateRunningApp: params.terminateRunningApp,
    url,
  });
}

async function invokeApplicationTargetOpen(
  params: DirectOpenParameters,
  app: string,
): Promise<void> {
  const { execution, interactor } = params;
  if (execution.launchConsole && isDeepLinkTarget(app)) {
    throw new AppError('INVALID_ARGS', LAUNCH_CONSOLE_DIRECT_APP_ONLY_MESSAGE);
  }
  if (execution.clearAppState) {
    if (isDeepLinkTarget(app)) {
      throw new AppError(
        'INVALID_ARGS',
        'Clearing app state requires an app target, not a deep link.',
      );
    }
    await interactor.setSetting('clear-app-state', 'clear', app);
  }
  await interactor.open(app, {
    activity: execution.activity,
    appBundleId: params.appBundleId,
    launchConsole: execution.launchConsole,
    launchArgs: execution.launchArgs ? [...execution.launchArgs] : undefined,
    terminateRunningApp: params.terminateRunningApp,
  });
}

/**
 * How an owner turns the requested `open` target into application identity. `bundle-id` owners
 * address applications by a dotted identifier and keep the session's current one otherwise;
 * `app-name` owners have no bundle identity to resolve.
 */
export type DirectOpenTargetIdentity = 'bundle-id' | 'app-name';

export type DirectApplicationLifecycleParams = Readonly<{
  binding: ApplicationLifecycleInteractorBinding;
  /** Names the owner in the failure reported for an operation it does not implement. */
  owner: string;
  openTargetIdentity: DirectOpenTargetIdentity;
  /** Owners whose native open does not replace a running application close it first. */
  closeBeforeRelaunch?: boolean;
  /** Port reverse is the one non-direct operation a provider owner may still implement. */
  configureProviderPortReverse?: ApplicationLifecycleRuntimeOperations['configureProviderPortReverse'];
}>;

/**
 * The lifecycle binding for an owner whose open and close are a single dispatch through its bound
 * interactor: no readiness phase, no runner, no runtime-hint or durable device state. Owners with
 * native sequencing of their own (Apple, Android) build their operations directly instead.
 */
export function bindDirectApplicationLifecycle(
  params: DirectApplicationLifecycleParams,
): ApplicationLifecycleRuntimeOperations {
  const { binding } = params;
  const unavailable = async (): Promise<never> => {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `This lifecycle operation is unavailable for ${params.owner}.`,
    );
  };
  return Object.freeze({
    resolveOpenTarget: async (input) => resolveDirectOpenTarget(params.openTargetIdentity, input),
    prepareApplicationOpen: async () => undefined,
    openApplication: async (input) => await openDirectApplication(params, input),
    applyRuntimeHints: unavailable,
    clearRuntimeHints: unavailable,
    closeApplication: async (input) => {
      await invokeApplicationClose({
        device: binding.device,
        interactor: await binding.resolveInteractor(input.execution, input.appBundleId),
        positionals: input.positionals,
      });
    },
    finalizeApplicationClose: async () => ({}),
    prepareAppleRunner: unavailable,
    configureProviderPortReverse: params.configureProviderPortReverse ?? unavailable,
  });
}

async function openDirectApplication(
  params: DirectApplicationLifecycleParams,
  input: OpenApplicationInput,
): Promise<OpenApplicationOutcome> {
  const { binding } = params;
  const interactor = await binding.resolveInteractor(input.execution, input.appBundleId);
  if (params.closeBeforeRelaunch && input.relaunch && input.target !== undefined) {
    await invokeApplicationClose({
      device: binding.device,
      interactor,
      positionals: [input.appBundleId ?? input.target],
    });
  }
  await invokeApplicationOpen({
    device: binding.device,
    interactor,
    positionals: input.positionals,
    appBundleId: input.appBundleId,
    execution: input.execution,
  });
  const followUpUrl = followUpRuntimeLaunchUrl(input);
  if (followUpUrl) {
    await invokeApplicationOpen({
      device: binding.device,
      interactor,
      positionals: [followUpUrl],
      appBundleId: input.appBundleId,
      execution: {
        ...input.execution,
        clearAppState: undefined,
        launchConsole: undefined,
        launchArgs: undefined,
      },
    });
  }
  return { appBundleId: input.appBundleId, timing: {} };
}

export function followUpRuntimeLaunchUrl(input: OpenApplicationInput): string | undefined {
  const url = input.runtimeLaunchUrl?.trim();
  const target = input.positionals.length === 1 ? input.positionals[0]?.trim() : undefined;
  if (!url || !target || isDeepLinkTarget(target)) return undefined;
  return url;
}

function resolveDirectOpenTarget(
  identity: DirectOpenTargetIdentity,
  input: OpenTargetResolutionInput,
): OpenTargetResolution {
  const requested = input.target;
  if (identity === 'app-name') {
    return Object.freeze(requested === undefined ? {} : { appName: requested });
  }
  const candidate = requested?.trim();
  const appBundleId =
    candidate && candidate.includes('.') && !isDeepLinkTarget(candidate)
      ? candidate
      : input.currentAppBundleId;
  return Object.freeze({
    ...(appBundleId === undefined ? {} : { appBundleId }),
    ...(requested === undefined ? {} : { appName: requested }),
  });
}

/** Canonical direct close semantics, independent of legacy command dispatch. */
export async function invokeApplicationClose(
  params: Readonly<{
    device: DeviceInfo;
    interactor: Interactor;
    positionals: readonly string[];
  }>,
): Promise<void> {
  const { device, interactor, positionals } = params;
  const app = positionals[0];
  if (!app) {
    if (device.platform === 'web') await interactor.close('');
    return;
  }
  await interactor.close(app);
}
