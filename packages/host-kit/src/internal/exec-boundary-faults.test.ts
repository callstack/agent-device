import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  runCmd,
  withCommandExecutorOverride,
  type CommandExecutorOverride,
} from '@agent-device/host-kit/command';

test('fail-Nth executor drives one deterministic command failure without hiding later calls', async () => {
  const failure = new AppError('COMMAND_FAILED', 'injected command failure', {
    hint: 'retry the boundary test',
  });
  const calls: string[][] = [];
  let callCount = 0;
  const override: CommandExecutorOverride = async (_command, args) => {
    callCount += 1;
    calls.push([...args]);
    if (callCount === 2) throw failure;
    return { stdout: JSON.stringify({ success: true, data: {} }), stderr: '', exitCode: 0 };
  };

  await withCommandExecutorOverride(override, async () => {
    assert.equal((await runCmd('fake-tool', ['first'])).exitCode, 0);
    await assert.rejects(runCmd('fake-tool', ['second']), (error: unknown) => error === failure);
    assert.equal((await runCmd('fake-tool', ['third'])).exitCode, 0);
  });

  assert.deepEqual(calls, [['first'], ['second'], ['third']]);
});
