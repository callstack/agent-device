import type {
  OpenApplicationInput,
  OpenApplicationOutcome,
  OpenApplicationRunnerDemand,
} from '@agent-device/contracts/application-lifecycle-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { resolveAppleSimulatorRunnerDemand } from './runner-demand.ts';
import { hasSimulatorBridge, type LaunchObservationPort } from './snapshot-observability.ts';

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
 * bridge, bounded by the launch-transition windows the bridge itself defines, so the first
 * observation never pays the launch and never falls back to a runner start for it. Any other
 * device, or a Simulator whose bridge cannot answer, keeps the fixed settle.
 */
export async function settleAppleOpen(
  host: Pick<PlatformRuntimeHost, 'clock'>,
  binding: Readonly<{ device: DeviceInfo; signal: AbortSignal }>,
  input: OpenApplicationInput,
  localIosSimulator: boolean,
  observation: LaunchObservationPort | undefined,
  timing: MutableOpenTiming,
): Promise<void> {
  const startedAtMs = Date.now();
  if (localIosSimulator && hasSimulatorBridge(binding.device) && observation && input.appBundleId) {
    timing.postOpenObservation = await observation.awaitObservable(
      binding.device,
      input.appBundleId,
      binding.signal,
    );
  }
  if (localIosSimulator && timing.postOpenObservation !== 'observable') {
    await host.clock.sleep(POST_OPEN_SETTLE_MS, binding.signal);
  }
  timing.postOpenSettleDurationMs = Math.max(0, Date.now() - startedAtMs);
}
