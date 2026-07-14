import type { RunnerCommand } from './runner-contract.ts';
import {
  RUNNER_COMMAND_TRAIT_MANIFEST,
  type RunnerCommandTraitClass,
} from './runner-command-manifest.ts';

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

const RUNNER_COMMAND_TRAITS = Object.fromEntries(
  Object.entries(RUNNER_COMMAND_TRAIT_MANIFEST).map(([command, traitClass]) => [
    command,
    traitsForClass(traitClass),
  ]),
) as Record<RunnerCommand['command'], RunnerCommandTraits>;

export function readRunnerCommandTraits(command: RunnerCommand['command']): RunnerCommandTraits {
  return RUNNER_COMMAND_TRAITS[command];
}

export function isReadOnlyRunnerCommand(command: RunnerCommand['command']): boolean {
  return readRunnerCommandTraits(command).readOnly;
}

export function isRunnerReadinessProbeCommand(command: RunnerCommand['command']): boolean {
  return readRunnerCommandTraits(command).readinessProbe;
}

export function isRunnerReadinessPreflightExempt(command: RunnerCommand['command']): boolean {
  return readRunnerCommandTraits(command).readinessPreflightExempt;
}

export function canSkipRunnerReadinessPreflightAfterHealthyMutation(
  command: RunnerCommand['command'],
): boolean {
  return readRunnerCommandTraits(command).readinessPreflightSkipEligibleAfterHealthyMutation;
}

function traitsForClass(traitClass: RunnerCommandTraitClass): RunnerCommandTraits {
  switch (traitClass) {
    case 'default':
      return DEFAULT_TRAITS;
    case 'readinessPreflightExemptMutation':
      return READINESS_PREFLIGHT_EXEMPT_MUTATION_TRAITS;
    case 'readOnly':
      return READ_ONLY_TRAITS;
    case 'readOnlyReadinessProbe':
      return READ_ONLY_READINESS_PROBE_TRAITS;
    case 'preflightSkippableTouchMutation':
      return PREFLIGHT_SKIPPABLE_TOUCH_MUTATION_TRAITS;
  }
}
