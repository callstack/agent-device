import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resolvePlannedOperations } from '../execution-plan.ts';
import { runBatchCommands } from '../handlers/session-batch.ts';
import type { DaemonRequest } from '../types.ts';

test('an open that ends its batch has an unknown future', () => {
  assert.equal(resolvePlannedOperations(undefined), undefined);
  assert.equal(resolvePlannedOperations({ remainingSteps: [] }), undefined);
});

test('remaining observation steps resolve to their required operations', () => {
  const operations = resolvePlannedOperations({
    remainingSteps: [
      { command: 'snapshot', positionals: [], flags: {} },
      { command: 'wait', positionals: ['text', 'Ready'], flags: {} },
    ],
  });
  assert.ok(operations);
  assert.ok(operations.includes('captureSnapshot'));
  assert.ok(!operations.some((operation) => /^tap/.test(operation)));
});

test('batch steps carry the steps still ahead of them through the internal channel', async () => {
  const seen: Array<{ command: string; remaining: unknown }> = [];
  const req: DaemonRequest = {
    token: 't',
    session: 'session',
    command: 'batch',
    positionals: [],
    flags: { batchSteps: [{ command: 'open' }, { command: 'snapshot', flags: { depth: 1 } }] },
  };
  const response = await runBatchCommands(req, 'session', async (stepRequest) => {
    seen.push({
      command: stepRequest.command,
      remaining: stepRequest.internal?.executionPlan?.remainingSteps,
    });
    return { ok: true, data: {} };
  });

  assert.equal(response.ok, true);
  assert.deepEqual(seen, [
    {
      command: 'open',
      remaining: [{ command: 'snapshot', positionals: [], flags: { depth: 1 } }],
    },
    { command: 'snapshot', remaining: [] },
  ]);
});
