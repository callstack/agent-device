import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RunnerCommand } from '../runner-contract.ts';
import {
  canSkipRunnerReadinessPreflightAfterHealthyMutation,
  isReadOnlyRunnerCommand,
  isRunnerReadinessProbeCommand,
  readRunnerCommandTraits,
  type RunnerCommandTraits,
} from '../runner-command-traits.ts';

const EXPECTED_RUNNER_COMMAND_TRAITS = {
  tap: hotMutation(),
  mouseClick: defaults(),
  longPress: hotMutation(),
  drag: hotMutation(),
  remotePress: defaults(),
  type: defaults(),
  swipe: hotMutation(),
  scroll: hotMutation(),
  findText: readOnly(),
  querySelector: readOnly(),
  readText: readOnly(),
  snapshot: readOnly(),
  screenshot: readOnly(),
  back: defaults(),
  backInApp: defaults(),
  backSystem: defaults(),
  home: defaults(),
  rotate: defaults(),
  rotateGesture: defaults(),
  transformGesture: defaults(),
  appSwitcher: defaults(),
  keyboardDismiss: defaults(),
  keyboardReturn: defaults(),
  alert: readOnly(),
  pinch: defaults(),
  sequence: hotMutation(),
  recordStart: defaults(),
  recordStop: defaults(),
  status: readOnlyReadinessProbe(),
  uptime: readOnlyReadinessProbe(),
  shutdown: defaults(),
} satisfies Record<RunnerCommand['command'], RunnerCommandTraits>;

test('runner command traits classify every runner command in one table', () => {
  for (const [command, expectedTraits] of Object.entries(EXPECTED_RUNNER_COMMAND_TRAITS) as Array<
    [RunnerCommand['command'], RunnerCommandTraits]
  >) {
    assert.deepEqual(readRunnerCommandTraits(command), expectedTraits, command);
  }
});

test('runner command trait helpers read from the shared trait table', () => {
  for (const command of Object.keys(EXPECTED_RUNNER_COMMAND_TRAITS) as Array<
    RunnerCommand['command']
  >) {
    const traits = EXPECTED_RUNNER_COMMAND_TRAITS[command];
    assert.equal(isReadOnlyRunnerCommand(command), traits.readOnly, command);
    assert.equal(isRunnerReadinessProbeCommand(command), traits.readinessProbe, command);
    assert.equal(
      canSkipRunnerReadinessPreflightAfterHealthyMutation(command),
      traits.readinessPreflightSkipEligibleAfterHealthyMutation,
      command,
    );
  }
});

function defaults(): RunnerCommandTraits {
  return {
    readOnly: false,
    readinessProbe: false,
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

function hotMutation(): RunnerCommandTraits {
  return {
    ...defaults(),
    readinessPreflightSkipEligibleAfterHealthyMutation: true,
  };
}
