import { test } from 'vitest';
import type { RunnerCommand } from '../runner-contract.ts';
import { isRunnerReadinessProbeCommand, RUNNER_COMMAND_TRAITS } from '../runner-command-traits.ts';
import { readSwiftInlineCommands } from './runner-swift-settlement-fixtures.ts';

/**
 * The runner serves `status` and `uptime` inline — outside its journal and off the serial command
 * queue — which is why the daemon charges no exchange for them: an inline reply proves the runner is
 * reachable and nothing about queued work, so a charge for one could only ever be paid by the wrong
 * exchange (#2965). The `readinessProbe` trait is how the daemon names that set, and this tie is what
 * keeps the two sides one claim: add an inline arm in Swift that the trait missed and that reply would
 * discharge an unrelated command's charge; drop one and a genuinely queued command would go uncharged,
 * so a shutdown could hand off a runner with work on its queue.
 *
 * The Swift half is read from the runner's own switch rather than restated here, so the check cannot
 * agree with a stale copy of the answer.
 */

function readinessProbeCommands(): string[] {
  return (Object.keys(RUNNER_COMMAND_TRAITS) as RunnerCommand['command'][])
    .filter((command) => isRunnerReadinessProbeCommand({ command }))
    .sort();
}

test('the readinessProbe trait names exactly the commands the runner serves inline', () => {
  const inline = readSwiftInlineCommands();

  if (inline.length === 0) {
    throw new Error(
      'the runner serves no command inline, so the daemon must stop routing any reply as an inline answer',
    );
  }
  for (const command of inline) {
    if (!readinessProbeCommands().includes(command)) {
      throw new Error(`the runner answers "${command}" inline but the trait does not name it`);
    }
  }
  for (const command of readinessProbeCommands()) {
    if (!inline.includes(command)) {
      throw new Error(`the trait calls "${command}" a probe but the runner queues it`);
    }
  }
});
