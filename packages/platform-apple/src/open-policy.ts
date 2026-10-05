import type {
  LaunchConfirmation,
  OpenApplicationInput,
  OpenApplicationOutcome,
  OpenApplicationRunnerDemand,
} from '@agent-device/contracts/application-lifecycle-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { resolveAppleSimulatorRunnerDemand } from './runner-demand.ts';
import {
  hasSimulatorBridge,
  isProvenNotRunning,
  type LaunchObservation,
  type LaunchObservationPort,
} from './snapshot-observability.ts';
import type { LaunchConfirmationAttempt } from './launch-confirmation.ts';

/** Why an open failed because its launch URL has not completed for the app it names. */
const LAUNCH_CONFIRMATION_UNANSWERED_REASON = 'launch_confirmation_unanswered';

const POST_OPEN_SETTLE_MS = 300;

/**
 * How many times the settle reads and answers the confirmation. Two: the first answer can die with
 * the runner session that raised it, which is the state where handing the launch URL again is the
 * only thing left. A third round would cost another runner command and another observation for a
 * device that has now refused twice.
 */
const LAUNCH_CONFIRMATION_ROUNDS = 2;

type HeldLaunchOutcome = Readonly<{
  observed: LaunchObservation | undefined;
  launchConfirmation?: LaunchConfirmation;
  /** The launch has no process, or its recognized confirmation remains visible. */
  unanswered: boolean;
}>;

type HeldLaunchRound = Readonly<{
  observed: LaunchObservation | undefined;
  launchConfirmation?: LaunchConfirmation;
  /** Whether an accept has run or been attempted; only an accept can change what the bridge sees. */
  acceptAttempted: boolean;
  confirmationStillPresent: boolean;
}>;

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
 * A launch the bridge cannot read as up may be a launch URL SpringBoard holds behind a
 * confirmation, so any verdict short of `observable` — including a target discovery that failed on
 * its own deadline — reads the sheet. Only a verdict that proves the app up skips the read, and a
 * sheet that is not there costs one runner command.
 *
 * An accept is the only answer that changes the device, so only its outcome is re-observed: the URL
 * is in flight and this open is the only one that knows whether it landed. When the app is then
 * proven not running, the accept died with the runner session that raised it or the device dropped a
 * held URL, and the URL is handed over again and read once more. A launch still proven not running
 * afterwards fails the open with `launch_confirmation_unanswered` rather than returning green to a
 * session whose every later command then fails `app is not running`. A recognized prompt still
 * visible after a failed accept also fails the open, even if the app is running. A read that found no prompt, an
 * unrecognized prompt and an unresolved URL owner all leave the open as green as it was, with only
 * the one extra runner command spent.
 */
export async function settleAppleOpen(
  host: Pick<PlatformRuntimeHost, 'clock'>,
  binding: Readonly<{ device: DeviceInfo; signal: AbortSignal }>,
  input: OpenApplicationInput,
  localIosSimulator: boolean,
  launch: Readonly<{
    observation?: LaunchObservationPort;
    answerConfirmation?: () => Promise<LaunchConfirmationAttempt>;
    redispatchLaunchUrl?: () => Promise<void>;
  }>,
  timing: MutableOpenTiming,
): Promise<LaunchConfirmation | undefined> {
  const startedAtMs = Date.now();
  const observe = async () =>
    await observeLaunchedApp(binding, input, localIosSimulator, launch.observation);
  let observed = await observe();
  let launchConfirmation: LaunchConfirmation | undefined;
  const answer = launch.answerConfirmation;
  const held =
    answer && observed?.observation !== 'observable'
      ? await answerHeldLaunch(answer, launch.redispatchLaunchUrl, observe, observed)
      : undefined;
  if (held) {
    timing.runnerDemand = 'required';
    launchConfirmation = held.launchConfirmation;
    observed = held.observed;
    if (held.unanswered) {
      throw new AppError(
        'COMMAND_FAILED',
        `The Simulator has not completed the launch URL for ${input.appBundleId}.`,
        {
          reason: LAUNCH_CONFIRMATION_UNANSWERED_REASON,
          appBundleId: input.appBundleId,
          hint: 'iOS may still be holding an "Open in" prompt, or the answer died with the runner session that raised it. Inspect the current alert before deciding on another action.',
        },
      );
    }
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
  timing.postOpenSettleDurationMs = Math.max(0, Date.now() - startedAtMs);
  return launchConfirmation;
}

/**
 * Reads and answers the confirmation the launch may be held behind. Only an accept changes the
 * device: a read that finds no prompt, or a prompt this open must not answer, leaves the launch
 * exactly as the first verdict described it, at the cost of one runner command. Once an accept has
 * been attempted the launch URL is in flight and only this open knows whether it landed — an accept
 * that reported failure died with the runner session that raised it, and one that reported success
 * can still leave the device having dropped a held URL. Either way, an app then proven to have no
 * process is a launch that was lost, so the URL is handed over again and read once more.
 *
 * Every step keeps the bound it already had: `openurl` at `IOS_SIMULATOR_OPENURL_TIMEOUT_MS`, the
 * read and accept at the runner's alert timeouts, and the observation at the discovery deadline and
 * the bridge's own launch-transition windows. Nothing here adds an unbounded wait.
 */
async function answerHeldLaunch(
  answer: () => Promise<LaunchConfirmationAttempt>,
  redispatchLaunchUrl: (() => Promise<void>) | undefined,
  observe: () => Promise<LaunchObservation | undefined>,
  observed: LaunchObservation | undefined,
): Promise<HeldLaunchOutcome> {
  let round: HeldLaunchRound = {
    observed,
    acceptAttempted: false,
    confirmationStillPresent: false,
  };
  for (let roundIndex = 0; roundIndex < LAUNCH_CONFIRMATION_ROUNDS; roundIndex += 1) {
    round = await answerConfirmationOnce(answer, observe, round);
    const lastRound = roundIndex === LAUNCH_CONFIRMATION_ROUNDS - 1;
    if (
      round.confirmationStillPresent ||
      lastRound ||
      !acceptLeftTheUrlInFlight(round) ||
      !redispatchLaunchUrl
    )
      break;
    await redispatchLaunchUrl();
  }
  return {
    observed: round.observed,
    launchConfirmation: round.launchConfirmation,
    unanswered: acceptLeftTheUrlInFlight(round) || round.confirmationStillPresent,
  };
}

async function answerConfirmationOnce(
  answer: () => Promise<LaunchConfirmationAttempt>,
  observe: () => Promise<LaunchObservation | undefined>,
  round: HeldLaunchRound,
): Promise<HeldLaunchRound> {
  const attempt = await answer();
  const confirmationStillPresent =
    attempt.outcome === 'unanswered' && attempt.reason === 'alert-still-present';
  const acceptAttempted = round.acceptAttempted || acceptWasAttempted(attempt);
  const launchConfirmation =
    attempt.outcome === 'accepted' ? ('accepted' as const) : round.launchConfirmation;
  if (!acceptAttempted) {
    // Only an accept changes the device, so a read that found no prompt, an unrecognized prompt or
    // an unresolved URL owner leaves the launch as the verdict before it already described it.
    return {
      observed: round.observed,
      launchConfirmation,
      acceptAttempted,
      confirmationStillPresent,
    };
  }
  return {
    observed: await observe(),
    launchConfirmation,
    acceptAttempted,
    confirmationStillPresent,
  };
}

/**
 * An app proven to have no process after an accept is a launch this open still owns the URL for:
 * the hand-off or the answer did not land, so handing it over again is what is left.
 */
function acceptLeftTheUrlInFlight(round: HeldLaunchRound): boolean {
  return round.acceptAttempted && isProvenNotRunning(round.observed);
}

function acceptWasAttempted(attempt: LaunchConfirmationAttempt): boolean {
  return (
    attempt.outcome === 'accepted' ||
    (attempt.outcome === 'unanswered' && attempt.reason === 'alert-still-present') ||
    (attempt.outcome === 'unreadable' && attempt.step === 'alert-accept')
  );
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
