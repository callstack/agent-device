import type { RunnerCommand } from './runner-contract.ts';
import { RUNNER_COMMAND_TRAIT_MANIFEST } from './runner-command-manifest.ts';

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
  switch (RUNNER_COMMAND_TRAIT_MANIFEST[command.command]) {
    case 'default':
      return DEFAULT_TRAITS;
    case 'readinessPreflightExemptMutation':
      return READINESS_PREFLIGHT_EXEMPT_MUTATION_TRAITS;
    case 'readOnly':
      return READ_ONLY_TRAITS;
    case 'alertAction':
      return (command.action ?? 'get').toLowerCase() === 'get' ? READ_ONLY_TRAITS : DEFAULT_TRAITS;
    case 'readOnlyReadinessProbe':
      return READ_ONLY_READINESS_PROBE_TRAITS;
    case 'preflightSkippableTouchMutation':
      return PREFLIGHT_SKIPPABLE_TOUCH_MUTATION_TRAITS;
  }
}
