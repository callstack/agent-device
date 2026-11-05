import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { test } from 'vitest';
import { readRunnerRequestFixture } from '@agent-device/test-kit';
import type { RunnerCommand } from '../runner-contract.ts';
import {
  isReadOnlyRunnerCommand,
  readRunnerCommandTraits,
  RUNNER_COMMAND_TRAITS,
  type RunnerCommandTraits,
} from '../runner-command-traits.ts';
import { readSwiftOffQueueCommands } from './runner-swift-settlement-fixtures.ts';

const RUNNER_COMMANDS = Object.keys(RUNNER_COMMAND_TRAITS) as Array<RunnerCommand['command']>;

test('runner command trait table pins lifecycle-sensitive command groups', () => {
  const groups = {
    preflightSkippableTouchMutation: commandsWithTraits(hotMutation()),
    readOnly: commandsWithTraits(readOnly()),
    payloadDependent: payloadDependentCommands(),
    readOnlyReadinessProbe: commandsWithTraits(readOnlyReadinessProbe()),
    offQueueRead: commandsWithTraits(offQueueRead()),
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
    offQueueRead: ['snapshotBridge'],
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
      'pasteboardWrite',
      'recordStart',
      'recordStop',
      'remotePress',
      'rotate',
      'shutdown',
      'type',
      'volumeDown',
      'volumeUp',
    ],
  });
  assert.deepEqual(Object.values(groups).flat().sort(), [...RUNNER_COMMANDS].sort());
});

test('alert actions match the native read-only golden table', () => {
  const cases = JSON.parse(
    fs.readFileSync(
      new URL('../../../../contracts/fixtures/alert-command-traits.json', import.meta.url),
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

test('queued command read-only traits match the Swift parity fixture', () => {
  const cases = JSON.parse(
    fs.readFileSync(
      new URL('../../../../contracts/fixtures/runner-command-read-only.json', import.meta.url),
      'utf8',
    ),
  ) as Array<{ command: RunnerCommand; readOnly: boolean }>;
  const offQueue = new Set(readSwiftOffQueueCommands());
  const queued = new Set(
    readRunnerRequestFixture()
      .map(({ request }) => String(request.command))
      .filter((command) => !offQueue.has(command)),
  );
  assert.deepEqual(new Set(cases.map(({ command }) => command.command)), queued);
  for (const { command, readOnly } of cases) {
    assert.equal(readRunnerCommandTraits(command).readOnly, readOnly, JSON.stringify(command));
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
    queued: true,
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
    queued: false,
    readinessProbe: true,
  };
}

function offQueueRead(): RunnerCommandTraits {
  return {
    ...readOnly(),
    queued: false,
    readinessPreflightExempt: true,
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
