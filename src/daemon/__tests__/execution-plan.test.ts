import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resolveOpenApplicationPlan } from '../execution-plan.ts';
import { runBatchCommands } from '../handlers/session-batch.ts';
import type { DaemonRequest } from '../types.ts';

test('an open that ends its batch has an unknown future', () => {
  assert.equal(resolveOpenApplicationPlan(undefined), undefined);
  assert.equal(resolveOpenApplicationPlan({ remainingCommands: [] }), undefined);
});

test('remaining observation steps resolve to their declared operations', () => {
  const plan = resolveOpenApplicationPlan({ remainingCommands: ['snapshot', 'wait'] });
  assert.ok(plan);
  assert.ok(plan.operations.includes('captureSnapshot'));
  assert.ok(!plan.operations.some((operation) => /^tap/.test(operation)));
});

test('batch steps carry the commands still ahead of them through the internal channel', async () => {
  const seen: Array<{ command: string; remaining: readonly string[] | undefined }> = [];
  const req: DaemonRequest = {
    token: 't',
    session: 'session',
    command: 'batch',
    positionals: [],
    flags: { batchSteps: [{ command: 'open' }, { command: 'snapshot' }] },
  };
  const response = await runBatchCommands(req, 'session', async (stepRequest) => {
    seen.push({
      command: stepRequest.command,
      remaining: stepRequest.internal?.executionPlan?.remainingCommands,
    });
    return { ok: true, data: {} };
  });

  assert.equal(response.ok, true);
  assert.deepEqual(seen, [
    { command: 'open', remaining: ['snapshot'] },
    { command: 'snapshot', remaining: [] },
  ]);
});
