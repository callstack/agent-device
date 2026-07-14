import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RunnerCommand } from '../runner/runner-contract.ts';
import {
  canSkipRunnerReadinessPreflightAfterHealthyMutation,
  isReadOnlyRunnerCommand,
  isRunnerReadinessPreflightExempt,
  isRunnerReadinessProbeCommand,
  readRunnerCommandTraits,
  type RunnerCommandTraits,
} from '../runner/runner-command-traits.ts';
import { RUNNER_COMMAND_TRAIT_MANIFEST } from '../runner/runner-command-manifest.ts';

const EXPECTED_RUNNER_COMMAND_TRAITS = Object.fromEntries(
  Object.entries(RUNNER_COMMAND_TRAIT_MANIFEST).map(([command, traitClass]) => [
    command,
    expectedTraitsForClass(traitClass),
  ]),
) as Record<RunnerCommand['command'], RunnerCommandTraits>;

test('runner command traits are derived from the runner command manifest', () => {
  for (const [command, expectedTraits] of Object.entries(EXPECTED_RUNNER_COMMAND_TRAITS) as Array<
    [RunnerCommand['command'], RunnerCommandTraits]
  >) {
    assert.deepEqual(readRunnerCommandTraits(command), expectedTraits, command);
  }
});

test('runner command manifest pins lifecycle-sensitive command groups', () => {
  assert.deepEqual(commandsForClass('preflightSkippableTouchMutation'), [
    'desktopScroll',
    'drag',
    'gesture',
    'longPress',
    'scroll',
    'sequence',
    'swipe',
    'tap',
  ]);
  assert.deepEqual(commandsForClass('readOnly'), [
    'alert',
    'findText',
    'gestureViewport',
    'querySelector',
    'readText',
    'screenshot',
    'snapshot',
  ]);
  assert.deepEqual(commandsForClass('readOnlyReadinessProbe'), ['status', 'uptime']);
  assert.deepEqual(commandsForClass('readinessPreflightExemptMutation'), ['targetReset']);
});

test('runner command trait helpers read from the shared trait table', () => {
  for (const command of Object.keys(EXPECTED_RUNNER_COMMAND_TRAITS) as Array<
    RunnerCommand['command']
  >) {
    const traits = EXPECTED_RUNNER_COMMAND_TRAITS[command];
    assert.equal(isReadOnlyRunnerCommand(command), traits.readOnly, command);
    assert.equal(isRunnerReadinessProbeCommand(command), traits.readinessProbe, command);
    assert.equal(
      isRunnerReadinessPreflightExempt(command),
      traits.readinessPreflightExempt,
      command,
    );
    assert.equal(
      canSkipRunnerReadinessPreflightAfterHealthyMutation(command),
      traits.readinessPreflightSkipEligibleAfterHealthyMutation,
      command,
    );
  }
});

function commandsForClass(
  traitClass: (typeof RUNNER_COMMAND_TRAIT_MANIFEST)[RunnerCommand['command']],
): RunnerCommand['command'][] {
  return Object.entries(RUNNER_COMMAND_TRAIT_MANIFEST)
    .filter((entry) => entry[1] === traitClass)
    .map((entry) => entry[0] as RunnerCommand['command'])
    .sort();
}

function expectedTraitsForClass(
  traitClass: (typeof RUNNER_COMMAND_TRAIT_MANIFEST)[RunnerCommand['command']],
): RunnerCommandTraits {
  switch (traitClass) {
    case 'default':
      return defaults();
    case 'readinessPreflightExemptMutation':
      return preflightExemptMutation();
    case 'readOnly':
      return readOnly();
    case 'readOnlyReadinessProbe':
      return readOnlyReadinessProbe();
    case 'preflightSkippableTouchMutation':
      return hotMutation();
  }
}

function defaults(): RunnerCommandTraits {
  return {
    readOnly: false,
    readinessProbe: false,
    readinessPreflightExempt: false,
    readinessPreflightSkipEligibleAfterHealthyMutation: false,
  };
}

function readOnly(): RunnerCommandTraits {
  return {
    ...defaults(),
    readOnly: true,
  };
}

function readOnlyReadinessProbe(): RunnerCommandTraits {
  return {
    ...readOnly(),
    readinessProbe: true,
  };
}

function preflightExemptMutation(): RunnerCommandTraits {
  return {
    ...defaults(),
    readinessPreflightExempt: true,
  };
}

function hotMutation(): RunnerCommandTraits {
  return {
    ...defaults(),
    readinessPreflightSkipEligibleAfterHealthyMutation: true,
  };
}
