import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { test } from 'vitest';
import type { RunnerCommand } from '../runner-contract.ts';
import {
  isReadOnlyRunnerCommand,
  readRunnerCommandTraits,
  RUNNER_COMMAND_TRAITS,
  type RunnerCommandTraits,
} from '../runner-command-traits.ts';

const RUNNER_COMMANDS = Object.keys(RUNNER_COMMAND_TRAITS) as Array<RunnerCommand['command']>;

test('runner command trait table pins lifecycle-sensitive command groups', () => {
  const groups = {
    preflightSkippableTouchMutation: commandsWithTraits(hotMutation()),
    readOnly: commandsWithTraits(readOnly()),
    payloadDependent: payloadDependentCommands(),
    readOnlyReadinessProbe: commandsWithTraits(readOnlyReadinessProbe()),
    readinessPreflightExemptMutation: commandsWithTraits(preflightExemptMutation()),
    default: commandsWithTraits(defaults()),
  };
  assert.deepEqual(groups, {
    preflightSkippableTouchMutation: [
      'desktopScroll',
      'drag',
      'gesture',
      'longPress',
      'scroll',
      'sequence',
      'swipe',
      'tap',
    ],
    readOnly: [
      'appState',
      'findText',
      'gestureViewport',
      'querySelector',
      'readText',
      'screenshot',
      'snapshot',
    ],
    payloadDependent: ['alert'],
    readOnlyReadinessProbe: ['status', 'uptime'],
    readinessPreflightExemptMutation: ['activate', 'targetReset', 'terminate'],
    default: [
      'actionButton',
      'appSwitcher',
      'backInApp',
      'backSystem',
      'home',
      'keyboardDismiss',
      'keyboardReturn',
      'mouseClick',
      'recordStart',
      'recordStop',
      'remotePress',
      'rotate',
      'shutdown',
      'type',
    ],
  });
  assert.deepEqual(Object.values(groups).flat().sort(), [...RUNNER_COMMANDS].sort());
});

test('alert actions match the native read-only golden table', () => {
  // The fixture's `query` column records whether the alert request changes anything — `get` is the
  // one action that is side-effect-free — and each side consumes it under its own name: `readOnly`
  // for this daemon trait, retry eligibility for the Apple runner, which no longer classifies
  // commands by read-only-ness at all.
  const cases = JSON.parse(
    fs.readFileSync(
      new URL('../../../../../contracts/fixtures/alert-command-traits.json', import.meta.url),
      'utf8',
    ),
  ) as Array<{ name: string; command: RunnerCommand; query: boolean }>;
  assert.deepEqual(
    cases.map(({ command }) => command.action),
    [undefined, 'get', 'accept', 'dismiss'],
  );
  for (const { name, command, query } of cases) {
    assert.deepEqual(readRunnerCommandTraits(command), { ...defaults(), readOnly: query }, name);
    assert.equal(isReadOnlyRunnerCommand(command), query, name);
  }
});

function commandsWithTraits(traits: RunnerCommandTraits): RunnerCommand['command'][] {
  return RUNNER_COMMANDS.filter(
    (command) =>
      typeof RUNNER_COMMAND_TRAITS[command] !== 'function' &&
      isDeepStrictEqual(readRunnerCommandTraits({ command }), traits),
  ).sort();
}

function payloadDependentCommands(): RunnerCommand['command'][] {
  return RUNNER_COMMANDS.filter(
    (command) => typeof RUNNER_COMMAND_TRAITS[command] === 'function',
  ).sort();
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
