import {
  type ApplicationLifecycleRuntimeOperations,
  type CloseApplicationFinalizationInput,
  type CloseApplicationInput,
  type OpenApplicationInput,
  type OpenApplicationOutcome,
  type PrepareAppleRunnerInput,
  type PrepareAppleRunnerResult,
  hasRuntimeTransportHintValues,
} from '@agent-device/contracts/application-lifecycle-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import {
  bindLocalApplicationLifecycleInteractor,
  invokeApplicationClose,
  invokeApplicationOpen,
} from '@agent-device/contracts/application-lifecycle-interaction';
import { isDeepLinkTarget } from '@agent-device/contracts/command';
import { ensureAppleReady } from './readiness/runtime.ts';
import { isApplePlatform, isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

const POST_CLOSE_SETTLE_MS = 300;
const POST_OPEN_SETTLE_MS = 300;

/** The Apple package receives only the lazy tools and readiness ports it owns. */
type AppleLifecycleHost = Pick<
  PlatformRuntimeHost,
  | 'appleApplications'
  | 'appleTools'
  | 'clock'
  | 'commands'
  | 'deviceReadiness'
  | 'deviceShutdown'
  | 'localInteractors'
>;

type MutableOpenTiming = {
  -readonly [Key in keyof OpenApplicationOutcome['timing']]: OpenApplicationOutcome['timing'][Key];
};

type AppleLifecycleParams = Readonly<{
  host: AppleLifecycleHost;
  device: DeviceInfo;
  signal: AbortSignal;
}>;

/** Apple owns its lifecycle ordering; the root host exposes only lazy runner/tool ports. */
export function bindAppleApplicationLifecycle(
  params: AppleLifecycleParams,
): ApplicationLifecycleRuntimeOperations {
  const binding = bindLocalApplicationLifecycleInteractor({
    device: params.device,
    signal: params.signal,
    resolveInteractor: params.host.localInteractors.resolve,
  });
  return Object.freeze({
    resolveOpenTarget: async (input) =>
      await params.host.appleApplications.resolveOpenTarget(params.device, input),
    prepareApplicationOpen: async (input) => {
      await ensureAppleReady(params.host, params.device, params.signal, {
        onColdBootStart: input.prewarmRunnerOnColdBoot
          ? () => {
              void params.host.appleApplications
                .prewarmRunnerCache(params.device, input.execution, params.signal)
                .catch(() => {});
            }
          : undefined,
      });
    },
    openApplication: async (input) => await openAppleApplication(params.host, binding, input),
    applyRuntimeHints: async (input) =>
      await params.host.appleApplications.applyRuntimeHints(params.device, input),
    clearRuntimeHints: async (input) =>
      await params.host.appleApplications.clearRuntimeHints(params.device, input),
    closeApplication: async (input) => await closeAppleApplication(params.host, binding, input),
    finalizeApplicationClose: async (input) =>
      await finalizeAppleApplicationClose(params.host, params.device, params.signal, input),
    prepareAppleRunner: async (input) =>
      await prepareAppleRunner(params.host, params.device, params.signal, input),
    configureProviderPortReverse: unavailable,
  });
}

type BoundAppleInteractor = ReturnType<typeof bindLocalApplicationLifecycleInteractor>;

async function openAppleApplication(
  host: AppleLifecycleHost,
  binding: BoundAppleInteractor,
  input: OpenApplicationInput,
): Promise<OpenApplicationOutcome> {
  const timing: MutableOpenTiming = {};
  const localIosSimulator = isIosSimulator(binding.device);
  const runner = createRunnerPrewarm(host, binding, input, timing);
  const shouldPrewarmRunner =
    isIosFamily(binding.device) &&
    input.surface === 'app' &&
    input.positionals.length > 0 &&
    Boolean(input.appBundleId);
  if (localIosSimulator && shouldPrewarmRunner && !input.prewarmRunnerBeforeOpen) runner.schedule();
  await closeAppleApplicationForRelaunch(host, binding, input, localIosSimulator, timing);
  await applyAppleOpenRuntimeHints(input, timing);
  await prewarmAppleRunnerBeforeOpen(runner, shouldPrewarmRunner, input.prewarmRunnerBeforeOpen);
  const runnerTargetPredatesOpen = runner.wasAwaited();
  await dispatchAppleOpen(binding, input, localIosSimulator, timing);
  await finishAppleRunnerPrewarm(runner, shouldPrewarmRunner, input.relaunch);
  await notifyAppleRunnerRelaunch(
    host,
    binding,
    input,
    localIosSimulator,
    runnerTargetPredatesOpen,
  );
  await settleAppleOpen(host, binding, localIosSimulator, timing);
  return { appBundleId: input.appBundleId, timing };
}

async function closeAppleApplicationForRelaunch(
  host: AppleLifecycleHost,
  binding: BoundAppleInteractor,
  input: OpenApplicationInput,
  localIosSimulator: boolean,
  timing: MutableOpenTiming,
): Promise<void> {
  if (!shouldCloseForAppleRelaunch(input, localIosSimulator) || !input.target) return;
  const startedAtMs = Date.now();
  if (isApplePlatform(binding.device.platform) && !localIosSimulator) {
    await host.appleApplications.stopRunnerSession(binding.device.id);
  }
  await invokeApplicationClose({
    device: binding.device,
    interactor: await binding.resolveInteractor(input.execution, input.appBundleId),
    positionals: [input.appBundleId ?? input.target],
  });
  if (localIosSimulator) await host.clock.sleep(POST_CLOSE_SETTLE_MS, binding.signal);
  timing.relaunchCloseDurationMs = elapsed(startedAtMs);
}

async function applyAppleOpenRuntimeHints(
  input: OpenApplicationInput,
  timing: MutableOpenTiming,
): Promise<void> {
  if (!hasRuntimeTransportHintValues(input.runtimeHints)) return;
  if (!input.applyRuntimeHints) {
    throw new AppError('COMMAND_FAILED', 'Runtime hint operation was not admitted for this open.', {
      reason: 'runtime-hints-operation-missing',
    });
  }
  const startedAtMs = Date.now();
  await input.applyRuntimeHints({ appId: input.appBundleId, values: input.runtimeHints });
  timing.runtimeHintsDurationMs = elapsed(startedAtMs);
}

async function prewarmAppleRunnerBeforeOpen(
  runner: RunnerPrewarm,
  shouldPrewarmRunner: boolean,
  prewarmBeforeOpen: boolean,
): Promise<void> {
  if (!shouldPrewarmRunner || !prewarmBeforeOpen) return;
  runner.schedule(true);
  await runner.wait();
}

async function dispatchAppleOpen(
  binding: BoundAppleInteractor,
  input: OpenApplicationInput,
  localIosSimulator: boolean,
  timing: MutableOpenTiming,
): Promise<void> {
  const launch = openLaunchPlan(input, localIosSimulator);
  const startedAtMs = Date.now();
  await invokeApplicationOpen({
    device: binding.device,
    interactor: await binding.resolveInteractor(input.execution, input.appBundleId),
    positionals: launch.positionals,
    appBundleId: input.appBundleId,
    execution: input.execution,
    ...(localIosSimulator && input.relaunch && !input.execution.clearAppState
      ? { terminateRunningApp: true }
      : {}),
  });
  timing.openDispatchDurationMs = elapsed(startedAtMs);
  await dispatchAppleLaunchUrl(binding, input, launch.followUpUrl, timing);
}

async function dispatchAppleLaunchUrl(
  binding: BoundAppleInteractor,
  input: OpenApplicationInput,
  followUpUrl: string | undefined,
  timing: MutableOpenTiming,
): Promise<void> {
  if (!followUpUrl) {
    timing.launchUrlDurationMs = 0;
    return;
  }
  const execution = {
    ...input.execution,
    clearAppState: undefined,
    launchConsole: undefined,
    launchArgs: undefined,
  };
  const startedAtMs = Date.now();
  await invokeApplicationOpen({
    device: binding.device,
    interactor: await binding.resolveInteractor(execution, input.appBundleId),
    positionals: [followUpUrl],
    appBundleId: input.appBundleId,
    execution,
  });
  timing.launchUrlDurationMs = elapsed(startedAtMs);
}

async function finishAppleRunnerPrewarm(
  runner: RunnerPrewarm,
  shouldPrewarmRunner: boolean,
  relaunch: boolean,
): Promise<void> {
  if (shouldPrewarmRunner && !runner.wasScheduled()) runner.schedule();
  if (relaunch) await runner.wait();
  else runner.recordUnawaited();
}

async function notifyAppleRunnerRelaunch(
  host: AppleLifecycleHost,
  binding: BoundAppleInteractor,
  input: OpenApplicationInput,
  localIosSimulator: boolean,
  runnerTargetPredatesOpen: boolean,
): Promise<void> {
  if (!localIosSimulator || (!input.relaunch && !runnerTargetPredatesOpen)) return;
  await host.appleApplications.notifyRunnerAppRelaunched(
    binding.device,
    input.execution,
    binding.signal,
  );
}

async function settleAppleOpen(
  host: AppleLifecycleHost,
  binding: BoundAppleInteractor,
  localIosSimulator: boolean,
  timing: MutableOpenTiming,
): Promise<void> {
  const startedAtMs = Date.now();
  if (localIosSimulator) await host.clock.sleep(POST_OPEN_SETTLE_MS, binding.signal);
  timing.postOpenSettleDurationMs = elapsed(startedAtMs);
}

function shouldCloseForAppleRelaunch(
  input: OpenApplicationInput,
  localIosSimulator: boolean,
): boolean {
  return (
    Boolean(input.relaunch && input.target) &&
    !(localIosSimulator && !input.execution.clearAppState)
  );
}

async function closeAppleApplication(
  host: AppleLifecycleHost,
  binding: BoundAppleInteractor,
  input: CloseApplicationInput,
): Promise<void> {
  if (input.ensureReady) {
    await ensureAppleReady(host, binding.device, binding.signal);
  }
  if (isApplePlatform(binding.device.platform) && !isIosSimulator(binding.device)) {
    await host.appleApplications.stopRunnerSession(binding.device.id);
  }
  await invokeApplicationClose({
    device: binding.device,
    interactor: await binding.resolveInteractor(input.execution, input.appBundleId),
    positionals: input.positionals,
  });
  if (isIosSimulator(binding.device)) await host.clock.sleep(POST_CLOSE_SETTLE_MS, binding.signal);
}

async function finalizeAppleApplicationClose(
  host: AppleLifecycleHost,
  device: DeviceInfo,
  signal: AbortSignal,
  input: CloseApplicationFinalizationInput,
) {
  if (input.daemonShutdown) {
    await host.appleApplications.dismissCloseAlerts(device, input).catch(() => {});
  } else if (input.retainRunner) {
    host.appleApplications.scheduleRunnerIdleStop(device.id);
    await host.appleApplications.dismissCloseAlerts(device, input).catch(() => {});
  } else {
    await host.appleApplications.stopRunnerSession(device.id);
    await host.appleApplications.dismissCloseAlerts(device, input).catch(() => {});
  }
  const shutdown =
    input.shutdownTarget && isIosSimulator(device)
      ? await host.deviceShutdown.apple.shutdownTarget(device, signal)
      : undefined;
  return shutdown === undefined ? {} : { shutdown };
}

async function prepareAppleRunner(
  host: AppleLifecycleHost,
  device: DeviceInfo,
  signal: AbortSignal,
  input: PrepareAppleRunnerInput,
): Promise<PrepareAppleRunnerResult> {
  await ensureAppleReady(host, device, signal);
  return await host.appleApplications.prepareRunner(device, input, signal);
}

type RunnerPrewarm = Readonly<{
  schedule(propagateError?: boolean): void;
  wait(): Promise<void>;
  wasAwaited(): boolean;
  wasScheduled(): boolean;
  recordUnawaited(): void;
}>;

function createRunnerPrewarm(
  host: AppleLifecycleHost,
  binding: BoundAppleInteractor,
  input: OpenApplicationInput,
  timing: MutableOpenTiming,
): RunnerPrewarm {
  let pending: Promise<void> | undefined;
  let awaited = false;
  return {
    schedule: (propagateError = false) => {
      if (pending) return;
      timing.runnerPrewarmKind = 'session';
      timing.runnerPrewarmScheduled = true;
      pending = host.appleApplications.prewarmRunnerSession(
        binding.device,
        input.execution,
        binding.signal,
        propagateError,
      );
    },
    wait: async () => {
      if (!pending || awaited) return;
      awaited = true;
      const startedAtMs = Date.now();
      await pending;
      timing.runnerPrewarmWaited = true;
      timing.runnerPrewarmDurationMs = elapsed(startedAtMs);
    },
    wasAwaited: () => awaited,
    wasScheduled: () => pending !== undefined,
    recordUnawaited: () => {
      if (pending && !awaited) timing.runnerPrewarmWaited = false;
    },
  };
}

function openLaunchPlan(
  input: OpenApplicationInput,
  foldLaunchUrl: boolean,
): Readonly<{ positionals: readonly string[]; followUpUrl?: string }> {
  const url = input.runtimeLaunchUrl?.trim();
  const target = input.positionals.length === 1 ? input.positionals[0]?.trim() : undefined;
  if (!url || !target || isDeepLinkTarget(target)) return { positionals: input.positionals };
  if (foldLaunchUrl && !isDirectAppLaunch(input)) return { positionals: [target, url] };
  return { positionals: input.positionals, followUpUrl: url };
}

function isDirectAppLaunch(input: OpenApplicationInput): boolean {
  return (
    input.execution.clearAppState === true ||
    Boolean(input.execution.launchConsole?.trim()) ||
    Boolean(input.execution.launchArgs?.length)
  );
}

function isIosSimulator(device: DeviceInfo): boolean {
  return isIosFamily(device) && device.kind === 'simulator';
}

function elapsed(startedAtMs: number): number {
  return Math.max(0, Date.now() - startedAtMs);
}

async function unavailable(): Promise<never> {
  throw new AppError('UNSUPPORTED_OPERATION', 'This lifecycle operation is unavailable for Apple.');
}
