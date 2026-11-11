import type { RunnerCommand } from './runner-contract.ts';

export type RunnerCommandTraits = Readonly<{
  readOnly: boolean;
  /**
   * Whether the runner puts the command on its journal and serial command queue. A reply to a
   * command it serves off that queue proves nothing about queued work, so the session charges none.
   */
  queued: boolean;
  /** Whether the command only probes the runner, so answering it does not use a speculative runner. */
  readinessProbe: boolean;
  readinessPreflightExempt: boolean;
  readinessPreflightSkipEligibleAfterHealthyMutation: boolean;
}>;

const DEFAULT_TRAITS: RunnerCommandTraits = {
  readOnly: false,
  queued: true,
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
  queued: false,
  readinessProbe: true,
};

// A bridge read answers from the runner's own accessibility client, so its reply proves the runner
// answers and needs no readiness probe first, and it brings no app forward to probe for.
const OFF_QUEUE_READ_TRAITS: RunnerCommandTraits = {
  ...READ_ONLY_TRAITS,
  queued: false,
  readinessPreflightExempt: true,
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
  pressReadiness: READ_ONLY_TRAITS,
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
  snapshotBridge: OFF_QUEUE_READ_TRAITS,
  pasteboardWrite: DEFAULT_TRAITS,
  activate: READINESS_PREFLIGHT_EXEMPT_MUTATION_TRAITS,
  terminate: READINESS_PREFLIGHT_EXEMPT_MUTATION_TRAITS,
  targetReset: READINESS_PREFLIGHT_EXEMPT_MUTATION_TRAITS,
  shutdown: DEFAULT_TRAITS,
} as const satisfies Record<RunnerCommand['command'], RunnerCommandTraitsEntry>;

export type RunnerSurfacePolicy = 'none' | 'app-windows' | 'observed-screen' | 'resolved-modal';

const RUNNER_COMMAND_SURFACE_POLICY = {
  tap: 'app-windows',
  mouseClick: 'none',
  longPress: 'app-windows',
  drag: 'app-windows',
  remotePress: 'none',
  type: 'app-windows',
  swipe: 'app-windows',
  scroll: 'app-windows',
  desktopScroll: 'none',
  findText: 'app-windows',
  querySelector: 'app-windows',
  pressReadiness: 'app-windows',
  readText: 'app-windows',
  snapshot: 'app-windows',
  screenshot: 'observed-screen',
  backInApp: 'app-windows',
  backSystem: 'app-windows',
  home: 'none',
  rotate: 'none',
  gesture: 'app-windows',
  gestureViewport: 'app-windows',
  appSwitcher: 'app-windows',
  actionButton: 'none',
  volumeUp: 'none',
  volumeDown: 'none',
  keyboardDismiss: 'app-windows',
  keyboardReturn: 'none',
  alert: 'resolved-modal',
  sequence: 'app-windows',
  recordStart: 'observed-screen',
  recordStop: 'none',
  status: 'none',
  uptime: 'none',
  appState: 'none',
  snapshotBridge: 'none',
  pasteboardWrite: 'none',
  activate: 'none',
  terminate: 'none',
  targetReset: 'none',
  shutdown: 'none',
} as const satisfies Record<RunnerCommand['command'], RunnerSurfacePolicy>;

export function runnerCommandSurfacePolicy(command: RunnerCommand): RunnerSurfacePolicy {
  return RUNNER_COMMAND_SURFACE_POLICY[command.command];
}

export function isReadOnlyRunnerCommand(command: RunnerCommand): boolean {
  return readRunnerCommandTraits(command).readOnly;
}

export function isQueuedRunnerCommand(command: RunnerCommand): boolean {
  return readRunnerCommandTraits(command).queued;
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
