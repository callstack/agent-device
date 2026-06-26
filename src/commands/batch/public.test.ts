import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  BATCH_BLOCKED_COMMANDS,
  DEFAULT_BATCH_MAX_STEPS,
  INHERITED_PARENT_FLAG_KEYS,
  buildBatchStepFlags,
  runBatch,
  validateAndNormalizeBatchSteps,
} from '../../batch.ts';
import type { DaemonRequest } from '../../contracts.ts';

test('public batch entrypoint exports daemon-compatible orchestration helpers', async () => {
  const seenCommands: string[] = [];
  const req: Omit<DaemonRequest, 'token'> = {
    command: 'batch',
    positionals: [],
    flags: {
      platform: 'ios',
      udid: 'sim-1',
      batchSteps: [
        { command: 'open', positionals: ['settings'] },
        { command: 'wait', positionals: ['100'], flags: { platform: 'android' } },
      ],
    },
  };

  const response = await runBatch(req, 'resolved-session', async (stepReq) => {
    seenCommands.push(stepReq.command);
    assert.equal(stepReq.session, 'resolved-session');
    assert.equal(stepReq.flags?.session, 'resolved-session');
    if (stepReq.command === 'open') {
      assert.equal(stepReq.flags?.platform, 'ios');
      assert.equal(stepReq.flags?.udid, 'sim-1');
    }
    if (stepReq.command === 'wait') {
      assert.equal(stepReq.flags?.platform, 'android');
    }
    return { ok: true, data: { command: stepReq.command } };
  });

  assert.equal(response.ok, true);
  assert.deepEqual(seenCommands, ['open', 'wait']);
  if (response.ok) {
    assert.equal(response.data.total, 2);
    assert.equal(response.data.results[0]?.command, 'open');
  }
});

test('public batch helpers expose validation and flag policy', () => {
  assert.equal(DEFAULT_BATCH_MAX_STEPS, 100);
  assert.equal(BATCH_BLOCKED_COMMANDS.has('replay'), true);
  assert.equal(INHERITED_PARENT_FLAG_KEYS.includes('udid'), true);
  assert.deepEqual(validateAndNormalizeBatchSteps([{ command: 'WAIT', positionals: ['100'] }], 1), [
    { command: 'wait', positionals: ['100'], flags: {}, runtime: undefined },
  ]);
  assert.deepEqual(
    buildBatchStepFlags(
      { platform: 'ios', udid: 'sim-1', batchSteps: [{ command: 'open' }] },
      { batchMaxSteps: 10, platform: 'android' },
    ),
    { platform: 'android', udid: 'sim-1' },
  );
});
