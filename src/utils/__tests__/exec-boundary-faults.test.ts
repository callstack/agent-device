import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { createFailNthCommandExecutor } from '../../__tests__/test-utils/exec-faults.ts';
import { runCmd, withCommandExecutorOverride } from '@agent-device/host-kit/command';

test('fail-Nth executor drives one deterministic command failure without hiding later calls', async () => {
  const failure = new AppError('COMMAND_FAILED', 'injected command failure', {
    hint: 'retry the boundary test',
  });
  const driver = createFailNthCommandExecutor(2, failure);

  await withCommandExecutorOverride(driver.override, async () => {
    assert.equal((await runCmd('fake-tool', ['first'])).exitCode, 0);
    await assert.rejects(runCmd('fake-tool', ['second']), (error: unknown) => error === failure);
    assert.equal((await runCmd('fake-tool', ['third'])).exitCode, 0);
  });

  assert.deepEqual(
    driver.calls().map((call) => call.args),
    [['first'], ['second'], ['third']],
  );
});
