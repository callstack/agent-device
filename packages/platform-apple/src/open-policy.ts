import type {
  LaunchConfirmation,
  OpenApplicationInput,
  OpenApplicationOutcome,
  OpenApplicationRunnerDemand,
} from '@agent-device/contracts/application-lifecycle-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { resolveAppleSimulatorRunnerDemand } from './runner-demand.ts';
import {
  hasSimulatorBridge,
  type LaunchObservation,
  type LaunchObservationPort,
} from './snapshot-observability.ts';

const POST_OPEN_SETTLE_MS = 300;

export type MutableOpenTiming = {
  -readonly [Key in keyof OpenApplicationOutcome['timing']]: OpenApplicationOutcome['timing'][Key];
};

export type RunnerPrewarmPolicy = Readonly<{
  runnerDemand?: OpenApplicationRunnerDemand;
  shouldPrewarmRunner: boolean;
  awaitPrewarmAfterOpen: boolean;
}>;

/**
 * Only a local Simulator has a runner-free observation path (the host AX bridge), so only it
 * consults the plan and never waits for runner readiness after the open: bridge observation does
 * not need it, and the first runner-dependent command awaits the same startup under the runner
 * session lock. Physical devices keep their runner lifecycle unchanged.
 */
export function resolveRunnerPrewarmPolicy(
  device: DeviceInfo,
  input: OpenApplicationInput,
  localIosSimulator: boolean,
): RunnerPrewarmPolicy {
  // Only a Simulator with the host AX bridge has a runner-free observation path, so only it
  // consults the plan and skips the relaunch wait; every other Apple target keeps its lifecycle.
  const bridge = localIosSimulator && hasSimulatorBridge(device);
  const runnerDemand = bridge
    ? resolveAppleSimulatorRunnerDemand(input.execution.plannedOperations)
    : undefined;
  const shouldPrewarmRunner =
    isIosFamily(device) &&
    input.surface === 'app' &&
    input.positionals.length > 0 &&
    Boolean(input.appBundleId) &&
    runnerDemand !== 'none';
  return {
    ...(runnerDemand ? { runnerDemand } : {}),
    shouldPrewarmRunner,
    awaitPrewarmAfterOpen: input.relaunch && !bridge,
  };
}

/**
 * A proven observation-only plan keeps no runner it did not ask for: a speculative one (an earlier
 * prewarm no command has used) is released through the runner owner, in the background so the
 * observation path never waits for a runner to stop either.
 */
export function releaseSpeculativeRunner(
  host: Pick<PlatformRuntimeHost, 'appleApplications'>,
  binding: Readonly<{ device: DeviceInfo }>,
  input: OpenApplicationInput,
  policy: RunnerPrewarmPolicy,
): void {
  if (policy.runnerDemand !== 'none') return;
  void host.appleApplications
    .releaseSpeculativeRunner(binding.device, input.execution)
    .catch(() => {});
}

/**
 * Lets the opened app become observable before the open returns. A local Simulator asks its AX
 * bridge once the app's discovery settles, bounded by the discovery's own deadline and the
 * launch-transition windows the bridge itself defines, so the first observation never pays the
 * launch and never falls back to a runner start for it. Any other device, or a Simulator whose
 * bridge cannot answer, keeps the fixed settle.
 *
 * A launch the bridge reads as unobservable may be a launch URL SpringBoard holds behind a
 * confirmation. When the open can answer one, the settle answers it once and, after an accept,
 * observes the app again. Only that path needs the runner, so only it records the demand.
 */
export async function settleAppleOpen(
  host: Pick<PlatformRuntimeHost, 'clock'>,
  binding: Readonly<{ device: DeviceInfo; signal: AbortSignal }>,
  input: OpenApplicationInput,
  localIosSimulator: boolean,
  launch: Readonly<{
    observation?: LaunchObservationPort;
    answerConfirmation?: () => Promise<LaunchConfirmation | undefined>;
  }>,
  timing: MutableOpenTiming,
): Promise<LaunchConfirmation | undefined> {
  const startedAtMs = Date.now();
  const observe = async () =>
    await observeLaunchedApp(binding, input, localIosSimulator, launch.observation);
  let observed = await observe();
  let launchConfirmation: LaunchConfirmation | undefined;
  const answerConfirmation =
    observed?.observation === 'unobservable' ? launch.answerConfirmation : undefined;
  if (answerConfirmation) {
    launchConfirmation = await answerConfirmation();
    if (launchConfirmation) observed = await observe();
  }
  if (localIosSimulator && observed?.observation !== 'observable') {
    await host.clock.sleep(POST_OPEN_SETTLE_MS, binding.signal);
  }
  if (observed) {
    timing.postOpenObservation = observed.observation;
    if (observed.observation === 'probe-failed') {
      timing.postOpenObservationFailure = observed.failure;
    }
  }
  if (answerConfirmation) timing.runnerDemand = 'required';
  timing.postOpenSettleDurationMs = Math.max(0, Date.now() - startedAtMs);
  return launchConfirmation;
}

async function observeLaunchedApp(
  binding: Readonly<{ device: DeviceInfo; signal: AbortSignal }>,
  input: OpenApplicationInput,
  localIosSimulator: boolean,
  observation: LaunchObservationPort | undefined,
): Promise<LaunchObservation | undefined> {
  if (!localIosSimulator || !hasSimulatorBridge(binding.device)) return undefined;
  if (!observation || !input.appBundleId) return undefined;
  return await observation.awaitObservable(binding.device, input.appBundleId, binding.signal);
}
