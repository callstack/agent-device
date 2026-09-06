import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import type { RunnerCommand } from '../runner-contract.ts';
import {
  canSkipRunnerReadinessPreflightAfterHealthyMutation,
  isReadOnlyRunnerCommand,
  isRunnerReadinessPreflightExempt,
  isRunnerReadinessProbeCommand,
  readRunnerCommandTraits,
  type RunnerCommandTraits,
} from '../runner-command-traits.ts';
import { RUNNER_COMMAND_TRAIT_MANIFEST } from '../runner-command-manifest.ts';

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
    assert.deepEqual(readRunnerCommandTraits({ command }), expectedTraits, command);
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
    'findText',
    'gestureViewport',
    'querySelector',
    'readText',
    'screenshot',
    'snapshot',
  ]);
  assert.deepEqual(commandsForClass('alertAction'), ['alert']);
  assert.deepEqual(commandsForClass('readOnlyReadinessProbe'), ['status', 'uptime']);
  assert.deepEqual(commandsForClass('readinessPreflightExemptMutation'), [
    'activate',
    'targetReset',
    'terminate',
  ]);
});

test('runner command trait helpers read from the shared trait table', () => {
  for (const command of Object.keys(EXPECTED_RUNNER_COMMAND_TRAITS) as Array<
    RunnerCommand['command']
  >) {
    const traits = EXPECTED_RUNNER_COMMAND_TRAITS[command];
    assert.equal(isReadOnlyRunnerCommand({ command }), traits.readOnly, command);
    assert.equal(isRunnerReadinessProbeCommand({ command }), traits.readinessProbe, command);
    assert.equal(
      isRunnerReadinessPreflightExempt({ command }),
      traits.readinessPreflightExempt,
      command,
    );
    assert.equal(
      canSkipRunnerReadinessPreflightAfterHealthyMutation({ command }),
      traits.readinessPreflightSkipEligibleAfterHealthyMutation,
      command,
    );
  }
});

test('alert actions match the native read-only golden table', () => {
  const cases = JSON.parse(
    fs.readFileSync(
      new URL('../../../../../contracts/fixtures/alert-command-traits.json', import.meta.url),
      'utf8',
    ),
  ) as Array<{ name: string; command: RunnerCommand; readOnly: boolean }>;
  assert.deepEqual(
    cases.map(({ command }) => command.action),
    [undefined, 'get', 'accept', 'dismiss'],
  );
  for (const { name, command, readOnly } of cases) {
    assert.deepEqual(readRunnerCommandTraits(command), { ...defaults(), readOnly }, name);
    assert.equal(isReadOnlyRunnerCommand(command), readOnly, name);
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
    case 'alertAction':
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
