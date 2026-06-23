import type { RunnerCommand } from './runner-contract.ts';

export type RunnerCommandTraits = Readonly<{
  readOnly: boolean;
  readinessProbe: boolean;
  readinessPreflightSkipEligibleAfterHealthyMutation: boolean;
}>;

const DEFAULT_TRAITS: RunnerCommandTraits = {
  readOnly: false,
  readinessProbe: false,
  readinessPreflightSkipEligibleAfterHealthyMutation: false,
};

const READ_ONLY_TRAITS: RunnerCommandTraits = {
  ...DEFAULT_TRAITS,
  readOnly: true,
};

const READ_ONLY_READINESS_PROBE_TRAITS: RunnerCommandTraits = {
  ...READ_ONLY_TRAITS,
  readinessProbe: true,
};

// Only runner commands this daemon actually sends should become preflight-skip eligible.
// The retired tapSeries/dragSeries/interactionFrame wire commands were removed from both
// daemon and runner; an old daemon paired with a new runner gets a decode rejection and
// rebuilds via the source fingerprint. Keep this set narrow: eligibility is not inferred from
// every mutating or touch command, only commands whose healthy response currently proves enough
// runner/app liveness to skip the next uptime preflight.
const PREFLIGHT_SKIPPABLE_TOUCH_MUTATION_TRAITS: RunnerCommandTraits = {
  ...DEFAULT_TRAITS,
  readinessPreflightSkipEligibleAfterHealthyMutation: true,
};

const RUNNER_COMMAND_TRAITS = {
  tap: PREFLIGHT_SKIPPABLE_TOUCH_MUTATION_TRAITS,
  mouseClick: DEFAULT_TRAITS,
  longPress: PREFLIGHT_SKIPPABLE_TOUCH_MUTATION_TRAITS,
  drag: PREFLIGHT_SKIPPABLE_TOUCH_MUTATION_TRAITS,
  remotePress: DEFAULT_TRAITS,
  type: DEFAULT_TRAITS,
  swipe: PREFLIGHT_SKIPPABLE_TOUCH_MUTATION_TRAITS,
  scroll: PREFLIGHT_SKIPPABLE_TOUCH_MUTATION_TRAITS,
  findText: READ_ONLY_TRAITS,
  querySelector: READ_ONLY_TRAITS,
  readText: READ_ONLY_TRAITS,
  snapshot: READ_ONLY_TRAITS,
  screenshot: READ_ONLY_TRAITS,
  back: DEFAULT_TRAITS,
  backInApp: DEFAULT_TRAITS,
  backSystem: DEFAULT_TRAITS,
  home: DEFAULT_TRAITS,
  rotate: DEFAULT_TRAITS,
  rotateGesture: DEFAULT_TRAITS,
  transformGesture: DEFAULT_TRAITS,
  appSwitcher: DEFAULT_TRAITS,
  keyboardDismiss: DEFAULT_TRAITS,
  keyboardReturn: DEFAULT_TRAITS,
  alert: READ_ONLY_TRAITS,
  pinch: DEFAULT_TRAITS,
  sequence: PREFLIGHT_SKIPPABLE_TOUCH_MUTATION_TRAITS,
  recordStart: DEFAULT_TRAITS,
  recordStop: DEFAULT_TRAITS,
  status: READ_ONLY_READINESS_PROBE_TRAITS,
  uptime: READ_ONLY_READINESS_PROBE_TRAITS,
  shutdown: DEFAULT_TRAITS,
} satisfies Record<RunnerCommand['command'], RunnerCommandTraits>;

export function readRunnerCommandTraits(command: RunnerCommand['command']): RunnerCommandTraits {
  return RUNNER_COMMAND_TRAITS[command];
}

export function isReadOnlyRunnerCommand(command: RunnerCommand['command']): boolean {
  return readRunnerCommandTraits(command).readOnly;
}

export function isRunnerReadinessProbeCommand(command: RunnerCommand['command']): boolean {
  return readRunnerCommandTraits(command).readinessProbe;
}

export function canSkipRunnerReadinessPreflightAfterHealthyMutation(
  command: RunnerCommand['command'],
): boolean {
  return readRunnerCommandTraits(command).readinessPreflightSkipEligibleAfterHealthyMutation;
}
