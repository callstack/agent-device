import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import type { RunnerCommand } from '../runner-contract.ts';
import {
  RUNNER_COMMAND_TRAITS,
  runnerCommandSurfacePolicy,
  type RunnerSurfacePolicy,
} from '../runner-command-traits.ts';

test('runner surface preparation matches the cross-language policy fixture', () => {
  const rows = JSON.parse(
    fs.readFileSync(
      new URL('../../../../contracts/fixtures/runner-surface-policy.json', import.meta.url),
      'utf8',
    ),
  ) as Array<{ command: RunnerCommand['command']; policy: RunnerSurfacePolicy }>;
  assert.deepEqual(
    rows.map(({ command }) => command).sort(),
    Object.keys(RUNNER_COMMAND_TRAITS).sort(),
  );
  for (const { command, policy } of rows) {
    assert.equal(runnerCommandSurfacePolicy({ command }), policy, command);
  }
});
