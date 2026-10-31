import type { RunnerCommand } from './runner-contract.ts';

export type RunnerCommandTraits = Readonly<{
  readOnly: boolean;
  readinessProbe: boolean;
  readinessPreflightExempt: boolean;
  readinessPreflightSkipEligibleAfterHealthyMutation: boolean;
}>;

const DEFAULT_TRAITS: RunnerCommandTraits = {
  readOnly: false,
  readinessProbe: false,
  readinessPreflightExempt: false,
  readinessPreflightSkipEligibleAfterHealthyMutation: false,
};

const READINESS_PREFLIGHT_EXEMPT_MUTATION_TRAITS: RunnerCommandTraits = {
  ...DEFAULT_TRAITS,
  readinessPreflightExempt: true,
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

type RunnerCommandTraitsEntry =
  | RunnerCommandTraits
  | ((command: RunnerCommand) => RunnerCommandTraits);

const readAlertActionTraits = (command: RunnerCommand): RunnerCommandTraits =>
  (command.action ?? 'get').toLowerCase() === 'get' ? READ_ONLY_TRAITS : DEFAULT_TRAITS;

/**
 * Traits of every runner command the daemon can send. A command whose traits depend on its
 * payload maps to a function of the command instead of a fixed trait set.
 */
export const RUNNER_COMMAND_TRAITS = {
  tap: PREFLIGHT_SKIPPABLE_TOUCH_MUTATION_TRAITS,
  mouseClick: DEFAULT_TRAITS,
  longPress: PREFLIGHT_SKIPPABLE_TOUCH_MUTATION_TRAITS,
  drag: PREFLIGHT_SKIPPABLE_TOUCH_MUTATION_TRAITS,
  remotePress: DEFAULT_TRAITS,
  type: DEFAULT_TRAITS,
  swipe: PREFLIGHT_SKIPPABLE_TOUCH_MUTATION_TRAITS,
  scroll: PREFLIGHT_SKIPPABLE_TOUCH_MUTATION_TRAITS,
  desktopScroll: PREFLIGHT_SKIPPABLE_TOUCH_MUTATION_TRAITS,
  findText: READ_ONLY_TRAITS,
  querySelector: READ_ONLY_TRAITS,
  readText: READ_ONLY_TRAITS,
  snapshot: READ_ONLY_TRAITS,
  screenshot: READ_ONLY_TRAITS,
  backInApp: DEFAULT_TRAITS,
  backSystem: DEFAULT_TRAITS,
  home: DEFAULT_TRAITS,
  rotate: DEFAULT_TRAITS,
  gesture: PREFLIGHT_SKIPPABLE_TOUCH_MUTATION_TRAITS,
  gestureViewport: READ_ONLY_TRAITS,
  appSwitcher: DEFAULT_TRAITS,
  actionButton: DEFAULT_TRAITS,
  volumeUp: DEFAULT_TRAITS,
  volumeDown: DEFAULT_TRAITS,
  keyboardDismiss: DEFAULT_TRAITS,
  keyboardReturn: DEFAULT_TRAITS,
  alert: readAlertActionTraits,
  sequence: PREFLIGHT_SKIPPABLE_TOUCH_MUTATION_TRAITS,
  recordStart: DEFAULT_TRAITS,
  recordStop: DEFAULT_TRAITS,
  status: READ_ONLY_READINESS_PROBE_TRAITS,
  uptime: READ_ONLY_READINESS_PROBE_TRAITS,
  appState: READ_ONLY_TRAITS,
  pasteboardWrite: DEFAULT_TRAITS,
  activate: READINESS_PREFLIGHT_EXEMPT_MUTATION_TRAITS,
  terminate: READINESS_PREFLIGHT_EXEMPT_MUTATION_TRAITS,
  targetReset: READINESS_PREFLIGHT_EXEMPT_MUTATION_TRAITS,
  shutdown: DEFAULT_TRAITS,
} as const satisfies Record<RunnerCommand['command'], RunnerCommandTraitsEntry>;

/**
 * Whether the runner resolves a screen for the command: a window to book a gesture on, a viewport,
 * or a display to sample. Such a request for a multi-panel device names the lit panel (ADR 0025).
 */
const RUNNER_COMMAND_RESOLVES_SURFACE = {
  tap: true,
  mouseClick: false,
  longPress: true,
  drag: true,
  remotePress: false,
  type: true,
  swipe: true,
  scroll: true,
  desktopScroll: false,
  findText: false,
  querySelector: false,
  readText: true,
  snapshot: true,
  screenshot: true,
  backInApp: true,
  backSystem: true,
  home: false,
  rotate: false,
  gesture: true,
  gestureViewport: true,
  appSwitcher: true,
  actionButton: false,
  volumeUp: false,
  volumeDown: false,
  keyboardDismiss: true,
  keyboardReturn: false,
  alert: false,
  sequence: true,
  recordStart: true,
  recordStop: false,
  status: false,
  uptime: false,
  appState: false,
  pasteboardWrite: false,
  activate: false,
  terminate: false,
  targetReset: false,
  shutdown: false,
} as const satisfies Record<RunnerCommand['command'], boolean>;

export function runnerCommandResolvesSurface(command: RunnerCommand): boolean {
  return RUNNER_COMMAND_RESOLVES_SURFACE[command.command];
}

export function isReadOnlyRunnerCommand(command: RunnerCommand): boolean {
  return readRunnerCommandTraits(command).readOnly;
}

export function isRunnerReadinessProbeCommand(command: RunnerCommand): boolean {
  return readRunnerCommandTraits(command).readinessProbe;
}

export function isRunnerReadinessPreflightExempt(command: RunnerCommand): boolean {
  return readRunnerCommandTraits(command).readinessPreflightExempt;
}

export function canSkipRunnerReadinessPreflightAfterHealthyMutation(
  command: RunnerCommand,
): boolean {
  return readRunnerCommandTraits(command).readinessPreflightSkipEligibleAfterHealthyMutation;
}

export function readRunnerCommandTraits(command: RunnerCommand): RunnerCommandTraits {
  const traits: RunnerCommandTraitsEntry = RUNNER_COMMAND_TRAITS[command.command];
  return typeof traits === 'function' ? traits(command) : traits;
}
