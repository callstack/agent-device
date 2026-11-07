import { test } from 'vitest';
import type { RunnerCommand } from '../runner-contract.ts';
import {
  isQueuedRunnerCommand,
  isRunnerReadinessProbeCommand,
  RUNNER_COMMAND_TRAITS,
} from '../runner-command-traits.ts';
import { readSwiftOffQueueCommands } from './runner-swift-settlement-fixtures.ts';

/**
 * The runner serves `status`, `uptime`, and `snapshotBridge` off its queue — outside its journal and
 * off the serial command queue — which is why the daemon charges no exchange for them: such a reply
 * proves the runner is reachable and nothing about queued work, so a charge for one could only ever be
 * paid by the wrong exchange (#2965). The `queued` trait is how the daemon names that set, and this tie
 * is what keeps the two sides one claim: add an off-queue arm in Swift that the trait missed and that
 * reply would discharge an unrelated command's charge; drop one and a genuinely queued command would
 * go uncharged, so a shutdown could hand off a runner with work on its queue.
 *
 * The Swift half is read from the runner's own switch rather than restated here, so the check cannot
 * agree with a stale copy of the answer.
 */

const RUNNER_COMMANDS = Object.keys(RUNNER_COMMAND_TRAITS) as RunnerCommand['command'][];

function offQueueCommands(): string[] {
  return RUNNER_COMMANDS.filter((command) => !isQueuedRunnerCommand({ command })).sort();
}

test('the queued trait leaves out exactly the commands the runner serves off its queue', () => {
  const offQueue = readSwiftOffQueueCommands();

  if (offQueue.length === 0) {
    throw new Error(
      'the runner serves no command off its queue, so the daemon must stop routing any reply as an off-queue answer',
    );
  }
  for (const command of offQueue) {
    if (!offQueueCommands().includes(command)) {
      throw new Error(
        `the runner answers "${command}" off its queue but the trait calls it queued`,
      );
    }
  }
  for (const command of offQueueCommands()) {
    if (!offQueue.includes(command)) {
      throw new Error(`the trait calls "${command}" off-queue but the runner queues it`);
    }
  }
});

test('every readiness probe is served off the queue', () => {
  const offQueue = readSwiftOffQueueCommands();
  for (const command of RUNNER_COMMANDS.filter((name) =>
    isRunnerReadinessProbeCommand({ command: name }),
  )) {
    if (!offQueue.includes(command)) {
      throw new Error(`the readiness probe "${command}" must be answered off the runner's queue`);
    }
  }
});
